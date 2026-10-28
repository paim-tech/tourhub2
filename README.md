# 🧭 TourHub — App multi-usuário para agência de passeios

Aplicação **full-stack** com três perfis (Dono do App, Dono de Agência e Cliente),
autenticação, **banco de dados SQLite** e dados **compartilhados entre todos os usuários**.

## Perfis
- **Dono do App (admin):** vê tudo, valida pagamentos e libera agências, gerencia planos e a chave Pix.
- **Dono de Agência:** assina um plano (Pix ou outra forma), envia o comprovante e, **após aprovação**, cadastra passeios e gerencia reservas.
- **Cliente:** explora passeios das agências ativas, reserva e acompanha o status.


## 📱 Celular (PWA — app instalável)
O app é um **PWA completo**: instala no celular com ícone próprio, abre em tela cheia e funciona sem loja de aplicativos.
- **Botão "📲 Instalar app"** aparece dentro do próprio app quando o navegador permite.
- **Android (Chrome):** botão no app, ou menu ⋮ → **"Instalar app"**.
- **iPhone (Safari):** **Compartilhar** → **"Adicionar à Tela de Início"**.
- **Offline:** há página de fallback (`offline.html`) e cache versionado do app.
- **Atalhos:** toque longo no ícone → "Explorar passeios" / "Minhas reservas".
- Interface **mobile-first**: menu deslizável, campos de 16px (sem zoom no iOS), botões grandes e "safe area" para telas com notch.

## Arquivos
`server.js` (API+SQLite) · `public/index.html` (interface) · `public/manifest.webmanifest` · `public/sw.js` · `public/icon-*.png` · `Dockerfile` · `render.yaml`

## Rodar localmente
```bash
npm install
npm start
# abra http://localhost:3000
```
Acesso do dono do app: **admin@tourhub.app** / **admin123** (troque depois).

## Variáveis de ambiente
| Variável | Descrição | Padrão |
|---|---|---|
| `PORT` | Porta do servidor | `3000` |
| `DATA_DIR` | Pasta onde fica o arquivo `tourhub.db` | pasta do projeto |

## Publicar e obter um link público
O app é um servidor Node + SQLite. Você precisa de um host que rode Node **com disco persistente**.

### Render.com
1. Crie uma conta e um **Web Service** apontando para este repositório.
2. Build Command: `npm install` — Start Command: `npm start`.
3. Adicione um **Disk** montado em `/data` e a variável `DATA_DIR=/data`.
   (No plano gratuito o disco não está disponível — os dados se perdem ao reiniciar. Use um plano pago ou um Postgres.)
4. O Render fornece a URL pública (ex.: `https://tourhub.onrender.com`).

### Railway / Fly.io / VPS
- Railway: adicione um **Volume** montado em `/data` e `DATA_DIR=/data`.
- Docker: `docker build -t tourhub . && docker run -p 3000:3000 -v tourhub_data:/data -e DATA_DIR=/data tourhub`

## API (resumo)
`POST /api/register` · `POST /api/login` · `GET /api/me` · `GET/PUT /api/config`
`GET/POST/PUT /api/plans` · `GET/PATCH /api/agencies` · `POST/GET/PATCH /api/payments`
`GET/POST/PUT/DELETE /api/tours` · `GET/POST/PATCH /api/bookings` · `GET /api/stats`

## Segurança em produção
- Troque a senha do admin e defina um segredo próprio.
- Rode atrás de HTTPS (o host já fornece).
- Faça backup do arquivo `tourhub.db` (ou use Postgres).
