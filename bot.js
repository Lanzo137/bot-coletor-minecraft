const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');

const procurarMadeira = require('./coleta');
const crafting = require('./crafting');
const criarPainel = require('./painel');
const instalarFiltroInventario = require('./filtroInventario');
const armazenamentoMadeira = require('./armazenamentoMadeira');
const equipamentos = require('./equipamentos');

const bot = mineflayer.createBot({
    host: 'localhost',
    port: 7000,
    username: 'CaioF7'
});

const JOGADOR_AUTORIZADO = 'lanzoo__';

bot.loadPlugin(pathfinder);
criarPainel(bot);
equipamentos.instalar(bot);
instalarFiltroInventario(bot);

let preparandoBot = false;
let novoSpawnPendente = false;
let geracaoMorte = 0;
let modoComandoManual = false;
let aguardandoLiberacao = false;
let geracaoComando = 0;
let retomarDepoisPreparacao = false;

async function iniciarRotinaNormal() {
    if (modoComandoManual) return;

    // O evento spawn também acontece após uma morte. Não inicia duas preparações
    // simultâneas; guarda o respawn e trata-o assim que a etapa atual terminar.
    if (preparandoBot) {
        novoSpawnPendente = true;
        console.log('Respawn detectado durante a preparação; vou aguardar a etapa atual.');
        return;
    }

    preparandoBot = true;

    try {
        do {
            novoSpawnPendente = false;
            const geracaoAoIniciar = geracaoMorte;

            await new Promise(resolve => setTimeout(resolve, 2000));
            if (geracaoAoIniciar !== geracaoMorte || modoComandoManual) continue;

            const depositoAntesDoCrafting = await armazenamentoMadeira.depositarSeNecessario(
                bot,
                Movements,
                goals
            );
            if (geracaoAoIniciar !== geracaoMorte || modoComandoManual) continue;
            if (depositoAntesDoCrafting.pararColeta) {
                console.log('Rotina pausada ate resolver o armazenamento da madeira.');
                break;
            }

            try {
                const temMachado = await crafting(bot, Movements, goals);
                if (geracaoAoIniciar !== geracaoMorte || modoComandoManual) continue;

                if (temMachado) {
                    console.log('🌲 Tudo pronto! Começando a coletar madeira...');
                    procurarMadeira(bot, Movements, goals);
                } else {
                    console.log('Preparação incompleta; vou continuar coletando sem machado.');
                    procurarMadeira(bot, Movements, goals, true);
                }
            } catch (erro) {
                if (geracaoAoIniciar !== geracaoMorte || modoComandoManual) continue;
                console.error('Erro ao preparar o bot:', erro.message);
                console.log('Vou continuar coletando madeira sem machado.');
                procurarMadeira(bot, Movements, goals, true);
            }
        } while (novoSpawnPendente);
    } finally {
        preparandoBot = false;
        if (retomarDepoisPreparacao && !modoComandoManual) {
            retomarDepoisPreparacao = false;
            setImmediate(() => iniciarRotinaNormal());
        }
    }
}

bot.on('spawn', () => {
    console.log('Bot entrou no mundo!');
    if (modoComandoManual) {
        console.log('Modo de espera manual ativo; aguardando o comando L.');
        return;
    }
    iniciarRotinaNormal();
});

// V brings the bot to the authorized player; L resumes normal wood-gathering tasks.
// Commands from other players are ignored.
bot.on('chat', (jogador, mensagem) => {
    if (jogador !== JOGADOR_AUTORIZADO) return;

    const comando = mensagem.trim();

    if (comando === 'B') {
        const jogadorAlvo = bot.players[jogador]?.entity;
        if (!jogadorAlvo) {
            bot.chat('Nao consigo localizar voce agora; fique perto de mim e tente B novamente.');
            return;
        }

        const bau = armazenamentoMadeira.definirBauPertoDoJogador(
            bot,
            jogadorAlvo,
            jogador
        );

        if (!bau) {
            bot.chat('Nao encontrei bau ou bau-armadilha a ate 6 blocos de voce.');
            return;
        }

        const mensagem = `Bau de madeira definido em ${bau.x}, ${bau.y}, ${bau.z}.`;
        console.log(mensagem);
        bot.chat(mensagem);

        if (!modoComandoManual && armazenamentoMadeira.consumirPausaPorArmazenamento()) {
            if (preparandoBot) {
                retomarDepoisPreparacao = true;
            } else {
                iniciarRotinaNormal();
            }
        }
        return;
    }

    if (comando === 'L') {
        if (!modoComandoManual) return;
        if (!aguardandoLiberacao) {
            console.log('Ainda estou indo ate o jogador; o comando L sera aceito quando eu chegar.');
            return;
        }
        if (!bot.entity || bot.health <= 0) {
            console.log('Bot is not alive in the world yet; send L again after respawn.');
            return;
        }

        modoComandoManual = false;
        aguardandoLiberacao = false;
        armazenamentoMadeira.consumirPausaPorArmazenamento();
        geracaoComando++;
        console.log(`Comando L autorizado por ${jogador}: retomando as tarefas normais.`);
        if (preparandoBot) {
            console.log('A preparacao em andamento vai retomar sem iniciar uma segunda rotina.');
        } else {
            iniciarRotinaNormal();
        }
        return;
    }

    if (comando !== 'V') return;
    if (!bot.entity || bot.health <= 0) {
        console.log(`Recebi V de ${jogador}, mas o bot ainda nÃ£o estÃ¡ vivo no mundo.`);
        return;
    }

    modoComandoManual = true;
    aguardandoLiberacao = false;
    const minhaGeracao = ++geracaoComando;
    console.log(`Comando V autorizado por ${jogador}: interrompendo as tarefas atuais.`);

    procurarMadeira.parar(bot);
    crafting.interromper(bot);
    bot.pathfinder.stop();
    bot.stopDigging();

    if (bot.currentWindow && bot.currentWindow !== bot.inventory) {
        bot.closeWindow(bot.currentWindow);
    }

    const jogadorAlvo = bot.players[jogador]?.entity;
    if (!jogadorAlvo) {
        console.log(`NÃ£o encontrei ${jogador} no mundo para ir atÃ© ele.`);
        return;
    }

    bot.pathfinder.setMovements(new Movements(bot));
    console.log(`Indo atÃ© ${jogador}...`);
    bot.pathfinder.goto(new goals.GoalFollow(jogadorAlvo, 2))
        .then(() => {
            if (minhaGeracao === geracaoComando) {
                aguardandoLiberacao = true;
                console.log(`Cheguei perto de ${jogador}. Aguardando outro comando.`);
            }
        })
        .catch(erro => {
            if (minhaGeracao === geracaoComando) {
                aguardandoLiberacao = true;
                console.log(`NÃ£o consegui chegar atÃ© ${jogador}:`, erro.message);
            }
        });
});

bot.on('death', () => {
    geracaoMorte++;
    console.log('Bot morreu. Parando a coleta atual antes do respawn.');
    procurarMadeira.parar(bot);
});

bot.on('kicked', motivo => console.log('Bot foi removido do servidor:', motivo));
bot.on('end', motivo => console.log('Conexão com o servidor encerrada:', motivo || '(sem motivo informado)'));
bot.on('error', erro => console.error('Erro de conexão do bot:', erro.message));
