const B = "http://localhost:3100";
let tok = "";
async function api(m, p, b, expect) {
  const r = await fetch(B + p, { method: m, headers: { "Content-Type": "application/json", ...(tok ? { Authorization: "Bearer " + tok } : {}) }, body: b ? JSON.stringify(b) : undefined });
  const d = await r.json().catch(() => ({}));
  if (expect && r.status !== expect) throw new Error(`${m} ${p} => ${r.status} ${JSON.stringify(d)}`);
  return { status: r.status, d };
}
const ok = (c, m) => { if (!c) throw new Error("FALHOU: " + m); console.log("✓ " + m); };

(async () => {
  // 1. admin login
  let r = await api("POST", "/api/login", { email: "admin@tourhub.app", pass: "admin123", deviceId: "dev-test" }, 200);
  tok = r.d.token; ok(!!tok, "login do dono do app");
  let cfg = (await api("GET", "/api/config", null, 200)).d;
  ok(cfg.pixKey, "admin lê configuração Pix");

  // 2. register agency
  await api("POST", "/api/register", { role: "agency", name: "Ana", email: "ana@trilhas.com", pass: "123456", agency: { name: "Trilhas do Vale", doc: "12.345.678/0001-90", city: "Gramado", phone: "(54) 99999-1111" } }, 200);
  ok(true, "cadastro de agência");
  r = await api("POST", "/api/login", { email: "ana@trilhas.com", pass: "123456" }, 200);
  const agTok = r.d.token; tok = agTok;
  ok(r.d.user.role === "agency", "login da agência");

  // 3. agency tries to publish before paying -> blocked
  let blocked = await api("POST", "/api/tours", { title: "X", price: 10 }, 403);
  ok(blocked.status === 403, "agência bloqueada antes de pagar");

  // 4. plans + submit payment
  const plans = (await api("GET", "/api/plans", null, 200)).d;
  ok(plans.length >= 3, "lista de planos (" + plans.length + ")");
  await api("POST", "/api/payments", { planId: "pro", method: "pix", txid: "E999TEST", note: "pix enviado" }, 200);
  ok(true, "agência envia comprovante");

  // 5. admin approves
  tok = ""; r = await api("POST", "/api/login", { email: "admin@tourhub.app", pass: "admin123", deviceId: "dev-test" }, 200); tok = r.d.token;
  const pays = (await api("GET", "/api/payments", null, 200)).d;
  ok(pays.length === 1 && pays[0].status === "pending", "admin vê pagamento pendente");
  await api("PATCH", "/api/payments/" + pays[0].id, { status: "approved" }, 200);
  ok(true, "admin aprova e libera");
  const ags = (await api("GET", "/api/agencies", null, 200)).d;
  ok(ags[0].status === "active", "agência ativa após aprovação");

  // 6. agency creates tour
  tok = agTok;
  await api("POST", "/api/tours", { title: "Trilha da Cascata", city: "Gramado", duration: "4h", price: 150, capacity: 3, description: "Caminhada guiada" }, 200);
  const tours = (await api("GET", "/api/tours", null, 200)).d;
  ok(tours.length === 1, "agência cria passeio");
  const tourId = tours[0].id;

  // 7. client registers, sees tour, books
  tok = "";
  await api("POST", "/api/register", { role: "client", name: "João", email: "joao@cliente.com", pass: "123456" }, 200);
  r = await api("POST", "/api/login", { email: "joao@cliente.com", pass: "123456" }, 200);
  tok = r.d.token;
  const ct = (await api("GET", "/api/tours", null, 200)).d;
  ok(ct.length === 1 && ct[0].agency_phone, "cliente vê passeio de agência ativa");
  await api("POST", "/api/bookings", { tourId, date: "2030-01-15", people: 2 }, 200);
  ok(true, "cliente reserva 2 pessoas");
  // capacity check: 2 more (total 4 > 3) must fail
  const over = await api("POST", "/api/bookings", { tourId, date: "2030-01-15", people: 2 }, 409);
  ok(over.status === 409, "bloqueio de overbooking (capacidade 3)");

  // 8. agency confirms
  tok = agTok;
  let bks = (await api("GET", "/api/bookings", null, 200)).d;
  ok(bks.length === 1, "agência vê a reserva");
  await api("PATCH", "/api/bookings/" + bks[0].id, { status: "confirmed" }, 200);
  const st = (await api("GET", "/api/stats", null, 200)).d;
  ok(st.confirmed === 1 && st.revenue === 300, "estatísticas da agência (receita R$300)");

  // 9. admin dashboard stats
  tok = ""; r = await api("POST", "/api/login", { email: "admin@tourhub.app", pass: "admin123", deviceId: "dev-test" }, 200); tok = r.d.token;
  const ads = (await api("GET", "/api/stats", null, 200)).d;
  ok(ads.agencies === 1 && ads.activeAgencies === 1 && ads.mrr === 197 && ads.revenue === 300, "painel do dono do app consolidado");

  console.log("\n🎉 TODOS OS TESTES PASSARAM");
})().catch(e => { console.error("\n❌ " + e.message); process.exit(1); });
