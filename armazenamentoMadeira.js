const fs = require('node:fs');
const path = require('node:path');
const { Vec3 } = require('vec3');
const madeira = require('./madeira');

const ARQUIVO_BAU = path.join(__dirname, 'bau-madeira.json');
const RAIO_BAU_PERTO_DO_JOGADOR = 6;
const QUANTIDADE_SLOTS_MOCHILA = 27;
const QUANTIDADE_POR_PILHA = 64;
const TEMPO_LIMITE_CAMINHO_MS = 20_000;

let alvoBau = carregarAlvoBau();
let depositoEmAndamento = false;
let bauCheioNotificado = false;
let coletaPausadaPorArmazenamento = false;

function carregarAlvoBau() {
    try {
        const salvo = JSON.parse(fs.readFileSync(ARQUIVO_BAU, 'utf8'));
        if (
            Number.isInteger(salvo?.bau?.x) &&
            Number.isInteger(salvo?.bau?.y) &&
            Number.isInteger(salvo?.bau?.z)
        ) {
            return salvo;
        }
    } catch (erro) {
        if (erro.code !== 'ENOENT') {
            console.error('Nao consegui ler bau-madeira.json:', erro.message);
        }
    }

    return null;
}

function contarSlotsDeMadeiraCheios(bot) {
    // Slots 9-35 sao os 27 espacos principais; a hotbar fica livre para as ferramentas.
    const slotsMochila = bot.inventory.slots.slice(9, 36);

    return slotsMochila.length === QUANTIDADE_SLOTS_MOCHILA &&
        slotsMochila.every(item =>
            item && madeira.ehMadeiraBruta(item.name) && item.count === QUANTIDADE_POR_PILHA
        );
}

function procurarBauPertoDoJogador(bot, jogador) {
    const centro = jogador.position.floored();
    const encontrados = [];
    const raio = RAIO_BAU_PERTO_DO_JOGADOR;

    for (let x = -raio; x <= raio; x++) {
        for (let y = -3; y <= 3; y++) {
            for (let z = -raio; z <= raio; z++) {
                const distanciaQuadrada = x * x + y * y + z * z;
                if (distanciaQuadrada > raio * raio) continue;

                const posicao = centro.offset(x, y, z);
                const bloco = bot.blockAt(posicao);
                if (!bloco || !['chest', 'trapped_chest'].includes(bloco.name)) continue;

                encontrados.push({
                    posicao,
                    distanciaQuadrada
                });
            }
        }
    }

    encontrados.sort((a, b) => a.distanciaQuadrada - b.distanciaQuadrada);
    return encontrados[0]?.posicao || null;
}

function definirBauPertoDoJogador(bot, jogador, nomeJogador) {
    const posicaoBau = procurarBauPertoDoJogador(bot, jogador);
    if (!posicaoBau) return null;

    const alvoAnterior = alvoBau;
    alvoBau = {
        bau: {
            x: posicaoBau.x,
            y: posicaoBau.y,
            z: posicaoBau.z
        },
        marcadoPor: nomeJogador,
        posicaoJogador: {
            x: Math.floor(jogador.position.x),
            y: Math.floor(jogador.position.y),
            z: Math.floor(jogador.position.z)
        }
    };

    try {
        fs.writeFileSync(ARQUIVO_BAU, JSON.stringify(alvoBau, null, 2), 'utf8');
    } catch (erro) {
        console.error('Nao consegui salvar bau-madeira.json:', erro.message);
        alvoBau = alvoAnterior;
        return null;
    }

    bauCheioNotificado = false;
    return alvoBau.bau;
}

function obterMadeiraBruta(bot) {
    return bot.inventory.items().filter(item => madeira.ehMadeiraBruta(item.name));
}

function contarSlotsLivresParaMadeira(container, madeiraRestante) {
    const slotsDoBau = container.slots.slice(0, container.inventoryStart);

    return madeiraRestante.some(item =>
        slotsDoBau.some(slot =>
            !slot || (
                slot.type === item.type &&
                slot.metadata === item.metadata &&
                slot.count < slot.stackSize
            )
        )
    );
}

function avisarBauCheio(bot) {
    if (bauCheioNotificado) return;
    bauCheioNotificado = true;

    const { x, y, z } = alvoBau.bau;
    const mensagem = `Bau em ${x}, ${y}, ${z} cheio; nao consegui guardar toda a madeira.`;
    console.log(mensagem);
    bot.chat(mensagem);
}

async function irAteBau(bot, goals, posicao) {
    let temporizador;

    try {
        await Promise.race([
            bot.pathfinder.goto(new goals.GoalNear(posicao.x, posicao.y, posicao.z, 2)),
            new Promise((_, rejeitar) => {
                temporizador = setTimeout(
                    () => rejeitar(new Error('Tempo limite para chegar ao bau excedido')),
                    TEMPO_LIMITE_CAMINHO_MS
                );
            })
        ]);
    } finally {
        clearTimeout(temporizador);
    }
}

async function depositarSeNecessario(bot, Movements, goals) {
    if (depositoEmAndamento || !contarSlotsDeMadeiraCheios(bot)) {
        return { pararColeta: false };
    }

    if (!alvoBau) {
        coletaPausadaPorArmazenamento = true;
        console.log('Inventario com 27 pilhas de madeira bruta. Use B perto de um bau para definir o destino.');
        return { pararColeta: true };
    }

    depositoEmAndamento = true;
    let container;

    try {
        const posicao = new Vec3(alvoBau.bau.x, alvoBau.bau.y, alvoBau.bau.z);
        let blocoBau = bot.blockAt(posicao);

        if (blocoBau && !['chest', 'trapped_chest'].includes(blocoBau.name)) {
            coletaPausadaPorArmazenamento = true;
            console.log('O bau salvo nao foi encontrado nas coordenadas. Use B novamente perto do bau desejado.');
            return { pararColeta: true };
        }

        bot.pathfinder.setMovements(new Movements(bot));
        await irAteBau(bot, goals, posicao);

        blocoBau = bot.blockAt(posicao);
        if (!blocoBau || !['chest', 'trapped_chest'].includes(blocoBau.name)) {
            coletaPausadaPorArmazenamento = true;
            console.log('O bau nao esta mais no local salvo. Use B para escolher outro.');
            return { pararColeta: true };
        }

        container = await bot.openContainer(blocoBau);
        const madeira = obterMadeiraBruta(bot);

        for (const item of madeira) {
            await container.deposit(item.type, item.metadata, item.count);
        }

        const madeiraRestante = obterMadeiraBruta(bot);
        const aindaHaEspacoParaMadeira = contarSlotsLivresParaMadeira(container, madeira);

        if (!aindaHaEspacoParaMadeira) {
            avisarBauCheio(bot);
            coletaPausadaPorArmazenamento = true;
            return { pararColeta: true, bauCheio: true };
        }

        if (madeiraRestante.length > 0) {
            coletaPausadaPorArmazenamento = true;
            console.log('Ainda ha madeira no inventario, mas o deposito nao terminou. A coleta foi pausada para evitar perder itens.');
            return { pararColeta: true };
        }

        console.log('Madeira bruta guardada no bau.');
        return { pararColeta: false, madeiraGuardada: true };
    } catch (erro) {
        if (/full|space|room|destination/i.test(erro.message)) {
            avisarBauCheio(bot);
            coletaPausadaPorArmazenamento = true;
            return { pararColeta: true, bauCheio: true };
        }

        coletaPausadaPorArmazenamento = true;
        console.error('Falha ao guardar madeira no bau:', erro.message);
        return { pararColeta: true, erro };
    } finally {
        if (container) {
            try {
                await container.close();
            } catch (erro) {
                console.log('Nao consegui fechar o bau:', erro.message);
            }
        }

        depositoEmAndamento = false;
    }
}

function consumirPausaPorArmazenamento() {
    const estavaPausada = coletaPausadaPorArmazenamento;
    coletaPausadaPorArmazenamento = false;
    return estavaPausada;
}

module.exports = {
    definirBauPertoDoJogador,
    depositarSeNecessario,
    consumirPausaPorArmazenamento
};
