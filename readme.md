# Elo Store v3

Versão full-stack da Elo Store baseada no ZIP enviado.

## Incluído
- Catálogo com os preços oficiais de 500 a 10.000 Robux
- Página individual de produto
- Carrinho e checkout
- Formulário com nome, Discord, Roblox e comprovativo
- Número automático ELO-XXXXX
- Base de dados SQLite
- Histórico/consulta de pedidos
- Estados: Pendente → Pago → Em processamento → Entregue
- Painel `/admin.html`
- Gestão de stock e preços
- Cupão ELO10 (10%)
- Avaliações
- FAQ e Sobre nós
- Favicon/logo Elo
- Integração Discord por bot
- Criação de ticket por pedido
- Notificação de novos pedidos no canal Discord
- Proteção básica de upload e limite de tamanho
- Preparado para domínio próprio e SEO

## Instalação

1. Instala Node.js 20+.
2. Extrai o ZIP.
3. Executa `npm install`.
4. Copia `.env.example` para `.env`.
5. Preenche pelo menos:
   - `SESSION_SECRET`
   - `ADMIN_USERNAME`
   - `ADMIN_PASSWORD`
   - `PIX_KEY`
   - `PAYPAL_EMAIL`
6. Para Discord, preenche:
   - `DISCORD_BOT_TOKEN`
   - `DISCORD_GUILD_ID`
   - `DISCORD_ORDER_CHANNEL_ID`
   - `DISCORD_TICKET_CATEGORY_ID`
7. Executa `npm start`.
8. Abre `http://localhost:3000`.
9. Painel: `http://localhost:3000/admin.html`.

## Pagamentos
O checkout desta versão recolhe o método de pagamento e o comprovativo. A validação do pagamento é feita pelo administrador. Não há cobrança automática por cartão/PayPal/PIX nesta versão.

## Domínio
Quando fizeres deploy num serviço Node.js, aponta o domínio para o serviço e ativa HTTPS. O servidor já serve o frontend e a API no mesmo domínio.

## Segurança
Nunca coloques tokens do Discord, passwords de admin ou chaves privadas diretamente no HTML/JS. Usa sempre `.env` e não publiques o `.env`.


## Novidades no painel
- Anúncios no topo do site (informação, sucesso, aviso e alerta)
- Modo de manutenção com título e mensagem personalizados
- Gestão de cupões
- Gestão/moderação de avaliações
- Criar, editar stock/preço e ocultar produtos
- Visualização de comprovativos no painel
- Sessões de administrador com expiração real
