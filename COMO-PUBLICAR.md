# 🚀 Como publicar o TourHub (passo a passo)

O TourHub é um **servidor Node.js + banco SQLite**. Para funcionar no celular de várias
pessoas (multi-usuário), ele precisa rodar num host com **disco persistente**.

> **Por que disco?** O banco é um arquivo (`tourhub.db`). Sem disco persistente, os dados
> (agências, passeios, reservas) somem quando o servidor reinicia.

---

## 1) Testar no seu computador primeiro
```bash
npm install
npm start
# abra http://localhost:3000
```
Login do dono do app: **admin@tourhub.app** / **admin123**

---

## 2) Publicar na internet — Opção A: Railway (grátis, SEM GitHub)
1. Crie uma conta em https://railway.app
2. No seu computador, dentro desta pasta:
```bash
npm install
npm i -g @railway/cli
railway login          # abre o navegador para logar
railway init           # cria o projeto
railway up             # envia e faz o deploy
```
3. No painel do Railway (site):
   - Abra o serviço → **Settings → Volumes** → **Add Volume**, ponto de montagem: `/data`
   - Aba **Variables** → adicione: `DATA_DIR` = `/data`
   - Aba **Settings → Networking** → **Generate Domain** (essa é a sua URL pública)
4. Abra a URL no navegador. Pronto. ✅

---

## 3) Opção B: Render.com (precisa de um repositório Git)
1. Suba este código num repositório no GitHub (conta onde você tem acesso).
2. Em https://render.com → **New → Web Service** → escolha o repositório.
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance type:** Starter (o disco exige plano pago)
3. Adicione um **Disk**: mount path `/data`, e a variável `DATA_DIR` = `/data`.
4. O Render gera a URL pública automaticamente.
   (Há também o arquivo `render.yaml` pronto para **Blueprint**.)

---

## 4) Opção C: Docker / VPS própria
```bash
docker build -t tourhub .
docker run -d --name tourhub -p 80:3000 -v tourhub_data:/data -e DATA_DIR=/data tourhub
```
Acesse `http://SEU_IP`. Para HTTPS e domínio, use Nginx/Caddy na frente.

---

## 5) Instalar no celular (é um PWA)
Depois de publicado, abra a URL no celular:
- **Android (Chrome):** menu ⋮ → **"Instalar app"**
- **iPhone (Safari):** **Compartilhar** → **"Adicionar à Tela de Início"**

O app abre em tela cheia, com ícone próprio, como um app nativo.

---

## 6) Primeiro acesso e configuração
1. Entre como **Dono do App**: `admin@tourhub.app` / `admin123`
2. **Configurações** → cadastre a **chave Pix** e as formas de pagamento.
3. (Opcional) **Planos** → ajuste os valores de assinatura.
4. Saia e crie uma conta de **Dono de Agência** → escolha plano → envie o comprovante.
5. Volte como **Dono do App** → **Pagamentos** → **Aprovar e liberar**.
6. Crie uma conta de **Cliente** e faça uma reserva. 🎉

> **Segurança:** troque a senha do admin antes de divulgar o link.

---

## 7) Backup
Faça backup do arquivo `tourhub.db` (fica na pasta definida em `DATA_DIR`).
Sem ele, você perde os dados.
