const http = require('node:http');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PAINEL_PORT) || 3000;

const pagina = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Painel do Bot Minecraft</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, Segoe UI, sans-serif; background: #101714; color: #e8f0eb; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; padding: 32px 18px; background: radial-gradient(ellipse at top, #20372b, #101714 60%); }
    main { width: min(900px, 100%); margin: auto; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 22px; }
    h1 { margin: 0; font-size: clamp(1.5rem, 4vw, 2.2rem); }
    .status { border: 1px solid #3c5747; border-radius: 999px; padding: 8px 13px; color: #b9d7c2; background: #19271f; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    .card { border: 1px solid #33463a; border-radius: 16px; background: #17211c; padding: 20px; box-shadow: 0 12px 36px #0003; }
    .card h2 { margin: 0 0 16px; font-size: 1rem; color: #b6cabb; font-weight: 600; }
    .metric { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 10px; }
    .value { font-size: 1.5rem; font-weight: 700; }
    .track { height: 13px; overflow: hidden; border-radius: 10px; background: #0c120e; }
    .fill { height: 100%; width: 0; border-radius: inherit; transition: width .3s ease; background: #65ce7a; }
    .fill.food { background: #e4ad4e; }
    .inventory { grid-column: 1 / -1; }
    .items { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 9px; margin: 0; padding: 0; list-style: none; }
    .items li { display: flex; justify-content: space-between; gap: 12px; padding: 11px 12px; border: 1px solid #2c3a31; border-radius: 10px; background: #111a15; }
    .item-name { overflow-wrap: anywhere; color: #dbe7de; }
    .count { white-space: nowrap; color: #9bc6a5; font-weight: 700; }
    .empty { color: #94a59a; }
    footer { margin-top: 15px; color: #84958a; font-size: .85rem; text-align: right; }
    @media (max-width: 580px) { .grid { grid-template-columns: 1fr; } .inventory { grid-column: auto; } header { align-items: flex-start; flex-direction: column; } }
  </style>
</head>
<body>
  <main>
    <header><h1>🌲 Painel do bot</h1><span class="status" id="status">Conectando...</span></header>
    <section class="grid">
      <article class="card">
        <h2>Vida</h2>
        <div class="metric"><span>❤️</span><span class="value" id="healthValue">-- / 20</span></div>
        <div class="track"><div class="fill" id="healthBar"></div></div>
      </article>
      <article class="card">
        <h2>Fome</h2>
        <div class="metric"><span>🍗</span><span class="value" id="foodValue">-- / 20</span></div>
        <div class="track"><div class="fill food" id="foodBar"></div></div>
      </article>
      <article class="card inventory">
        <h2>Inventário (<span id="stackCount">0</span> pilhas)</h2>
        <ul class="items" id="items"><li class="empty">Aguardando os dados do bot...</li></ul>
      </article>
    </section>
    <footer>Atualização automática a cada segundo · <span id="updated">--</span></footer>
  </main>
  <script>
    const byId = id => document.getElementById(id);
    function atualizarBarra(id, valor) {
      byId(id).style.width = Math.max(0, Math.min(100, valor / 20 * 100)) + '%';
    }
    async function atualizar() {
      try {
        const resposta = await fetch('/api/status', { cache: 'no-store' });
        const dados = await resposta.json();
        byId('status').textContent = dados.status;
        byId('healthValue').textContent = dados.health === null ? '-- / 20' : dados.health + ' / 20';
        byId('foodValue').textContent = dados.food === null ? '-- / 20' : dados.food + ' / 20';
        atualizarBarra('healthBar', dados.health || 0);
        atualizarBarra('foodBar', dados.food || 0);
        byId('stackCount').textContent = dados.items.length;
        const lista = byId('items');
        lista.replaceChildren();
        if (!dados.items.length) {
          const vazio = document.createElement('li');
          vazio.className = 'empty';
          vazio.textContent = dados.status === 'No mundo' ? 'Inventário vazio.' : 'Inventário indisponível enquanto o bot não está no mundo.';
          lista.append(vazio);
        } else {
          for (const item of dados.items) {
            const linha = document.createElement('li');
            const nome = document.createElement('span');
            nome.className = 'item-name';
            nome.textContent = item.name;
            const quantidade = document.createElement('span');
            quantidade.className = 'count';
            quantidade.textContent = '× ' + item.count;
            linha.append(nome, quantidade);
            lista.append(linha);
          }
        }
        byId('updated').textContent = new Date().toLocaleTimeString('pt-BR');
      } catch {
        byId('status').textContent = 'Painel sem conexão';
      }
    }
    atualizar();
    setInterval(atualizar, 1000);
  </script>
</body>
</html>`;

function criarPainel(bot) {
    const servidor = http.createServer((req, res) => {
        const caminho = new URL(req.url, `http://${HOST}:${PORT}`).pathname;

        if (caminho === '/api/status') {
            const noMundo = Boolean(bot.entity);
            const health = noMundo && Number.isFinite(bot.health) ? Math.max(0, bot.health) : null;
            const food = noMundo && Number.isFinite(bot.food) ? Math.max(0, bot.food) : null;
            const items = noMundo
                ? bot.inventory.items().map(item => ({
                    name: item.displayName || item.name,
                    count: item.count
                }))
                : [];

            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store'
            });
            res.end(JSON.stringify({
                status: !noMundo ? 'Conectando / fora do mundo' : bot.health <= 0 ? 'Morto' : 'No mundo',
                health,
                food,
                items
            }));
            return;
        }

        if (caminho !== '/') {
            res.writeHead(404);
            res.end('Não encontrado');
            return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(pagina);
    });

    servidor.on('error', erro => {
        console.error('Não consegui iniciar o painel:', erro.message);
    });

    servidor.listen(PORT, HOST, () => {
        console.log(`Painel disponível em http://${HOST}:${PORT}`);
    });

    return servidor;
}

module.exports = criarPainel;
