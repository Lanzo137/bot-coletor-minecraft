// Configurações da rotina de coleta.
const crafting = require('./crafting');
const armazenamentoMadeira = require('./armazenamentoMadeira');
const madeira = require('./madeira');
const equipamentos = require('./equipamentos');
const RAIO_BUSCA_MADEIRA = 48;
const RAIO_BUSCA_ITENS = 16;
const RAIO_COLETA_IMEDIATA = 8;
const BLOCOS_ENTRE_COLETAS = 3;
const RAIO_APROXIMACAO_MADEIRA = 3;
const RAIO_APROXIMACAO_ITEM = 1;
const INTERVALO_TENTATIVA_MS = 1000;
const INTERVALO_COLETA_ITENS_MS = 60_000;
const ESPERA_DROP_MS = 350;
const INTERVALO_TENTATIVA_MACHADO_MS = 60_000;
const TEMPO_LIMITE_ACAO_MS = 15_000;

let ultimaVerificacao = Date.now();
let ultimaTentativaMachado = 0;
let coletaEmAndamento = false;
let coletaAtiva = false;
let novaColetaPendente = false;
let geracaoColeta = 0;
let temporizadorProximaTentativa = null;
let blocosDesdeUltimaColeta = 0;
let origemExploracao = null;
let indiceExploracao = 0;

function esperar(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Executa uma ação com limite de tempo e sempre limpa o temporizador. */
async function executarComTempoLimite(acao, tempoLimiteMs) {
    let temporizador;

    try {
        return await Promise.race([
            acao(),
            new Promise((_, rejeitar) => {
                temporizador = setTimeout(
                    () => rejeitar(new Error('Tempo limite excedido')),
                    tempoLimiteMs
                );
            })
        ]);
    } finally {
        clearTimeout(temporizador);
    }
}

function pararColeta(bot) {
    coletaAtiva = false;
    novaColetaPendente = false;
    geracaoColeta++;
    clearTimeout(temporizadorProximaTentativa);
    temporizadorProximaTentativa = null;

    bot.pathfinder.stop();
    bot.stopDigging();
}

function agendarProximaTentativa(
    bot,
    Movements,
    goals,
    geracao,
    intervaloMs = INTERVALO_TENTATIVA_MS
) {
    if (!coletaAtiva || geracao !== geracaoColeta) return;

    clearTimeout(temporizadorProximaTentativa);
    temporizadorProximaTentativa = setTimeout(() => {
        procurarMadeira(bot, Movements, goals);
    }, intervaloMs);
}

async function procurarMadeira(bot, Movements, goals, aguardarCooldownCrafting = false) {
    // Evita repetir imediatamente o crafting que acabou de falhar no spawn.
    if (aguardarCooldownCrafting) ultimaTentativaMachado = Date.now();

    coletaAtiva = true;

    // Evita iniciar dois ciclos ao mesmo tempo.
    if (coletaEmAndamento) {
        novaColetaPendente = true;
        return;
    }

    coletaEmAndamento = true;
    const minhaGeracao = geracaoColeta;
    let houveProgresso = false;

    try {
        bot.pathfinder.setMovements(new Movements(bot));

        const depositoInicial = await armazenamentoMadeira.depositarSeNecessario(
            bot,
            Movements,
            goals
        );
        if (minhaGeracao !== geracaoColeta) return;
        if (depositoInicial.pararColeta) {
            pararColeta(bot);
            return;
        }

        let machado = await equipamentos.equiparMelhorMachado(bot);

        // Se perdeu ou ainda não tem machado, tenta prepará-lo periodicamente.
        if (
            !machado &&
            Date.now() - ultimaTentativaMachado >= INTERVALO_TENTATIVA_MACHADO_MS
        ) {
            ultimaTentativaMachado = Date.now();
            console.log('Sem machado: vou tentar prepará-lo antes de continuar.');

            try {
                await crafting(bot, Movements, goals);
            } catch (erro) {
                console.log('Não consegui preparar o machado agora:', erro.message);
            }

            if (minhaGeracao !== geracaoColeta) return;

            machado = await equipamentos.equiparMelhorMachado(bot);
        }

        if (!machado) {
            console.log('Vou continuar coletando madeira e tentar o machado novamente depois.');
        }

        // A cada 60 segundos, procura drops num raio maior, mesmo sem troncos por perto.
        if (Date.now() - ultimaVerificacao >= INTERVALO_COLETA_ITENS_MS) {
            ultimaVerificacao = Date.now();
            console.log('🔎 Fazendo a varredura de itens deixados para trás...');
            await coletarItens(bot, goals, RAIO_BUSCA_ITENS, minhaGeracao);
            if (minhaGeracao !== geracaoColeta) return;

            const depositoAposVarredura = await armazenamentoMadeira.depositarSeNecessario(
                bot,
                Movements,
                goals
            );
            if (minhaGeracao !== geracaoColeta) return;
            if (depositoAposVarredura.pararColeta) {
                pararColeta(bot);
                return;
            }
        }

        const bloco = bot.findBlock({
            matching: block => madeira.ehMadeiraBruta(block.name),
            maxDistance: RAIO_BUSCA_MADEIRA
        });

        if (!bloco) {
            if (!origemExploracao) {
                origemExploracao = bot.entity.position.clone();
                indiceExploracao = 0;
            }
            const angulo = (indiceExploracao % 8) * (Math.PI / 4);
            const raio = indiceExploracao < 8 ? 24 : 40;
            const x = Math.floor(origemExploracao.x + Math.cos(angulo) * raio);
            const z = Math.floor(origemExploracao.z + Math.sin(angulo) * raio);
            indiceExploracao = (indiceExploracao + 1) % 16;
            console.log(`Sem madeira por perto; explorando (${x}, ${z}).`);
            try {
                await executarComTempoLimite(
                    () => bot.pathfinder.goto(new goals.GoalXZ(x, z)),
                    TEMPO_LIMITE_ACAO_MS
                );
            } catch (erro) {
                if (minhaGeracao !== geracaoColeta) return;
                console.log('Falha ao chegar ao ponto de exploracao:', erro.message);
                bot.pathfinder.stop();
            }
            console.log('Não encontrei madeira. Vou procurar novamente.');
            return;
        }

        origemExploracao = null;
        indiceExploracao = 0;
        console.log('Encontrei madeira!');
        console.log('Tipo:', bloco.name);
        console.log('Posição:', bloco.position);

        let madeiraQuebrada = false;

        try {
            // Cada deslocamento e tentativa de quebra pode levar até 15 segundos.
            await executarComTempoLimite(
                () => bot.pathfinder.goto(
                    new goals.GoalNear(
                        bloco.position.x,
                        bloco.position.y,
                        bloco.position.z,
                        RAIO_APROXIMACAO_MADEIRA
                    )
                ),
                TEMPO_LIMITE_ACAO_MS
            );
            if (minhaGeracao !== geracaoColeta) return;

            // Confirma que o bloco ainda é um tronco antes de tentar quebrá-lo.
            const blocoAtual = bot.blockAt(bloco.position);
            if (blocoAtual && madeira.ehMadeiraBruta(blocoAtual.name)) {
                await executarComTempoLimite(
                    () => bot.dig(blocoAtual),
                    TEMPO_LIMITE_ACAO_MS
                );
                if (minhaGeracao !== geracaoColeta) return;
                console.log('Madeira quebrada!');
                madeiraQuebrada = true;
                houveProgresso = true;
            } else {
                console.log('O tronco não está mais nesse local.');
            }
        } catch (erro) {
            if (minhaGeracao !== geracaoColeta) return;
            console.log(
                `A ação excedeu ${TEMPO_LIMITE_ACAO_MS / 1000} segundos ou falhou. Pulando este bloco...`
            );
            bot.pathfinder.stop();
            bot.stopDigging();
        }

        // Recolhe os drops a cada três troncos, aproximadamente uma árvore pequena.
        if (madeiraQuebrada) {
            blocosDesdeUltimaColeta++;

            if (blocosDesdeUltimaColeta >= BLOCOS_ENTRE_COLETAS) {
                blocosDesdeUltimaColeta = 0;
                await esperar(ESPERA_DROP_MS);
                if (minhaGeracao !== geracaoColeta) return;
                console.log(`Quebrei ${BLOCOS_ENTRE_COLETAS} troncos; recolhendo os itens próximos.`);
                await coletarItens(bot, goals, RAIO_COLETA_IMEDIATA, minhaGeracao);
                if (minhaGeracao !== geracaoColeta) return;
            }
        }
    } catch (erro) {
        if (minhaGeracao !== geracaoColeta) return;
        console.log('Erro durante a coleta:', erro.message);
        bot.pathfinder.stop();
        bot.stopDigging();
    } finally {
        coletaEmAndamento = false;

        if (novaColetaPendente && coletaAtiva) {
            novaColetaPendente = false;
            agendarProximaTentativa(
                bot,
                Movements,
                goals,
                geracaoColeta,
                houveProgresso ? 0 : INTERVALO_TENTATIVA_MS
            );
        } else {
            agendarProximaTentativa(
                bot,
                Movements,
                goals,
                minhaGeracao,
                houveProgresso ? 0 : INTERVALO_TENTATIVA_MS
            );
        }
    }
}

async function coletarItens(
    bot,
    goals,
    raioBusca = RAIO_BUSCA_ITENS,
    geracao = geracaoColeta
) {
    const itens = Object.values(bot.entities).filter(entity =>
        entity.name === 'item' &&
        entity.position.distanceTo(bot.entity.position) <= raioBusca
    );

    // Visita primeiro os drops mais próximos para reduzir deslocamentos.
    itens.sort((a, b) =>
        a.position.distanceTo(bot.entity.position) -
        b.position.distanceTo(bot.entity.position)
    );

    if (itens.length === 0) {
        console.log('Nenhum item deixado para trás.');
        return;
    }

    console.log(`Encontrei ${itens.length} item(ns) no chão!`);

    for (const item of itens) {
        if (!coletaAtiva || geracao !== geracaoColeta) return;

        // A entidade pode ter desaparecido enquanto o bot se deslocava.
        if (!bot.entities[item.id]) continue;

        try {
            await executarComTempoLimite(
                () => bot.pathfinder.goto(
                    new goals.GoalNear(
                        item.position.x,
                        item.position.y,
                        item.position.z,
                        RAIO_APROXIMACAO_ITEM
                    )
                ),
                TEMPO_LIMITE_ACAO_MS
            );
            if (!coletaAtiva || geracao !== geracaoColeta) return;
            console.log('Cheguei perto de um item para recolhê-lo.');
        } catch (erro) {
            if (!coletaAtiva || geracao !== geracaoColeta) return;
            bot.pathfinder.stop();
            console.log('Não consegui chegar até este item:', erro.message);
        }
    }
}

procurarMadeira.parar = pararColeta;

module.exports = procurarMadeira;
