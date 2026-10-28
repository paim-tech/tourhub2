# TourHub — Publicação segura

Como publicar o TourHub **com segurança** (versão multi-usuário com servidor).

---

## 1. Antes de publicar — checklist obrigatório

| # | Item | Como fazer |
|---|------|-----------|
| 1 | **Senha do administrador** | Variável `ADMIN_PASSWORD` (nunca deixar a padrão `admin123`) |
| 2 | **E-mail do administrador** | Variável `ADMIN_EMAIL` |
| 3 | **Rodar em produção** | `NODE_ENV=production` |
| 4 | **Banco em disco persistente** | `DATA_DIR=/data` + volume montado |
| 5 | **HTTPS ativo** | O host fornece (Render/Railway dão HTTPS automático) |
| 6 | **SMTP configurado** | `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `APP_URL` |
| 7 | **2FA do admin ativado** | Painel do App → Configurações → Verificação em duas etapas |
| 8 | **Testar o fluxo completo** | cadastro → pagamento → aprovação → reserva |
| 9 | **Fazer backup** | copiar `DATA_DIR/tourhub.db` periodicamente |

> Sem SMTP configurado, o servidor avisa no log e a recuperação de senha não envia e-mails reais.

---

## 2. O que já está protegido

- **Senhas** com `scrypt` + salt (nunca em texto puro).
- **Sessões** com token aleatório de 256 bits e **expiração de 12 h** (renovada a cada uso).
- **Limite de requisições**: 10 tentativas de login/registro/recuperação por 5 min; 120 escritas por minuto.
- **Cabeçalhos de segurança**: CSP, HSTS (em produção), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`.
- **Força HTTPS** em produção (redireciona `http` → `https`).
- **Validação de entrada** (e-mail, tamanhos, faixas de preço/capacidade, formato de data).
- **Erros sem vazamento** de stack trace.
- **`x-powered-by` desativado**.
- **Banco com consultas preparadas** (sem injeção de SQL).
- **Controle de acesso no servidor** (admin / agência / cliente validados a cada rota).
- **Recuperação de senha por e-mail** com token de uso único, hash SHA-256 e validade de 30 min.
- **Verificação em duas etapas (2FA/TOTP)** para o administrador, com desafio de uso único de 5 min.
- **Bloqueio por aparelho**: o dono do app só entra pelos aparelhos autorizados (o 1º login registra o aparelho principal).

---

## 3. Recuperação de senha por e-mail

### Como funciona
1. Na tela de login, o usuário clica em **“Esqueci minha senha”**.
2. Informa o e-mail → o servidor gera um **token de uso único** (válido por 30 min) e envia o link.
3. O link abre a tela **“Criar nova senha”**.
4. Ao salvar, **todas as sessões antigas são encerradas**.

### Segurança
- A resposta é sempre genérica — **não revela se o e-mail existe** (evita enumeração de usuários).
- O token é guardado **com hash**; mesmo vazando o banco, não é possível reutilizá-lo.
- Token **de uso único** e com **expiração**.
- Rotas de recuperação **limitadas por IP** (anti-abuso).

### Configurar o envio (SMTP)
Defina as variáveis de ambiente:

```
SMTP_HOST=smtp.seudominio.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=no-reply@seudominio.com
SMTP_PASS=sua-senha-de-app
MAIL_FROM=TourHub <no-reply@seudominio.com>
APP_URL=https://seu-dominio.com
```

Funciona com **qualquer provedor SMTP**: Gmail (use *Senha de app*), Outlook, Zoho, Brevo, SendGrid, Amazon SES.

> **Sem SMTP configurado:** em desenvolvimento o link aparece no log do servidor; em produção o envio falha e o usuário continua vendo a mensagem genérica (nenhuma senha é alterada).

---

## 4. Verificação em duas etapas (2FA) do administrador

### Ativar
1. Entre como administrador → **Configurações** → **🔐 Verificação em duas etapas (2FA)**.
2. Clique em **Ativar 2FA**.
3. O sistema mostra a **chave secreta** e o **link otpauth**.
4. No aplicativo autenticador (Google Authenticator, Authy, Microsoft Authenticator), adicione a conta informando a chave.
5. Digite o **código de 6 dígitos** e confirme.

### Depois de ativado
- O login do administrador passa a ter **duas etapas**: senha → **código de 6 dígitos**.
- O código é verificado com janela de ±30 s (tolerância de relógio).

### Desativar
Em **Configurações → 2FA**, informe o **código atual** e a **senha da conta**.

### Segurança
- Segredo TOTP **único por conta**, nunca reutilizado.
- O passo intermediário usa um **desafio de uso único** que expira em 5 min.
- Desativar exige **senha + código** (não basta ter a sessão aberta).

---

## 5. Bloqueio por aparelho (dono do app)

### Como funciona
1. No **primeiro login** do administrador, o aparelho é registrado automaticamente como **⭐ Principal**.
2. Qualquer **outro aparelho** que tente entrar recebe: *"Este aparelho não está autorizado a acessar este painel."*
3. O aparelho autorizado renova o registro a cada login.

### Gerenciar aparelhos
Em **Configurações → 📱 Aparelhos autorizados**:
- vê o aparelho principal (com o último acesso);
- **Revoga** aparelhos antigos — ao revogar o principal, o próximo login registra um novo principal.

### Importante
- O identificador fica no `localStorage` do navegador. Se o usuário limpar os dados, o aparelho perde a identificação (use *revogar* para corrigir).
- Vale **somente para o administrador**; clientes e agências entram normalmente.

---

## 6. O que NÃO está incluído (limitações honestas)

- **A validação do pagamento é manual** (o dono do app aprova no painel).
- **Sem backup automático** — configure um cron ou use o recurso do host.
- **Fotos dos passeios** não são enviadas nesta versão (só os apps estáticos locais têm fotos).
- **CSP com `unsafe-inline`** é necessário porque o app usa scripts/estilos inline; migrar para arquivos externos permitiria uma CSP mais rígida.
- **2FA disponível apenas para o administrador** (agências e clientes usam só senha).

---

## 6. Publicar no Render (recomendado — HTTPS + disco persistente)

1. Crie uma conta em **render.com**.
2. **New → Web Service** → conecte seu repositório.
3. Configurações:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. Em **Environment Variables**, adicione:
   - `NODE_ENV` = `production`
   - `DATA_DIR` = `/data`
   - `ADMIN_EMAIL` = `seu-email@dominio.com`
   - `ADMIN_PASSWORD` = `uma-senha-forte`
   - `APP_URL` = `https://tourhub.onrender.com` (a URL final)
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`
5. Em **Disks**, adicione: nome `tourhub-data`, mount `/data`, 1 GB.
6. **Create Web Service** → URL **https://** pronta.

> O arquivo `render.yaml` já deixa tudo isso pré-configurado.

---

## 7. Publicar com Docker (VPS própria)

```bash
docker build -t tourhub .
docker run -d --name tourhub \
  -p 3000:3000 \
  -e NODE_ENV=production -e DATA_DIR=/data \
  -e ADMIN_EMAIL=seu-email@dominio.com -e ADMIN_PASSWORD='uma-senha-forte' \
  -e APP_URL=https://seu-dominio.com \
  -e SMTP_HOST=smtp.seudominio.com -e SMTP_PORT=587 \
  -e SMTP_USER=no-reply@seudominio.com -e SMTP_PASS='sua-senha-de-app' \
  -e MAIL_FROM='TourHub <no-reply@seudominio.com>' \
  -v tourhub-data:/data \
  tourhub
```

**Caddy (HTTPS automático):**
```
seu-dominio.com {
  reverse_proxy localhost:3000
}
```

---

## 8. Backup

```bash
cp /data/tourhub.db /backup/tourhub-$(date +%F).db
```

---

## 9. Primeiro acesso

- **E-mail:** o que você definiu em `ADMIN_EMAIL`
- **Senha:** o que você definiu em `ADMIN_PASSWORD`

Depois de entrar: **Configurações → Chave Pix** e **Planos**, e **ative o 2FA**.
