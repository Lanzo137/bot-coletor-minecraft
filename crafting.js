const { Vec3 } = require('vec3');
const tiposMadeira = require('./madeira');
const equipamentos = require('./equipamentos');

const versoesDeMorte = new WeakMap();
const botsComEventoMorte = new WeakSet();

function obterVersaoDeMorte(bot) {
    if (!botsComEventoMorte.has(bot)) {
        botsComEventoMorte.add(bot);
        versoesDeMorte.set(bot, 0);
        bot.on('death', () => {
            versoesDeMorte.set(bot, (versoesDeMorte.get(bot) || 0) + 1);
        });
    }

    return versoesDeMorte.get(bot) || 0;
}

function interromper(bot) {
    const versaoAtual = obterVersaoDeMorte(bot);
    versoesDeMorte.set(bot, versaoAtual + 1);
}

function esperar(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function contarTroncos(bot) {
    return bot.inventory.items()
        .filter(item => tiposMadeira.ehMadeiraBruta(item.name))
        .reduce((total, item) => total + item.count, 0);
}

function contarTabuas(bot) {
    return bot.inventory.items()
        .filter(item => item.name.endsWith('_planks'))
        .reduce((total, item) => total + item.count, 0);
}

function contarItem(bot, nomeItem) {
    return bot.inventory.items()
        .filter(item => item.name === nomeItem)
        .reduce((total, item) => total + item.count, 0);
}

async function esperarItemNoInventario(bot, nomeItem, tentativas = 6) {
    for (let tentativa = 0; tentativa < tentativas; tentativa++) {
        const item = bot.inventory.items().find(item => item.name === nomeItem);
        if (item) return item;

        // Aguarda a atualização do inventário enviada pelo servidor após o craft.
        await esperar(500);
    }

    return null;
}

// Usa as tabuas correspondentes ao tronco, caule ou hifa coletados.
async function criarTabuas(bot, goals, quantidadeMinima = 1, foiInterrompido = () => false) {
    while (contarTabuas(bot) < quantidadeMinima) {
        if (foiInterrompido()) return false;

        let tronco = bot.inventory.items().find(item =>
            tiposMadeira.ehMadeiraBruta(item.name)
        );

        if (!tronco) {
            console.log('Faltam troncos; vou coletar somente o necessário para as tábuas.');
            const madeiraColetada = await pegarMadeiraComAsMaos(bot, goals, 1, foiInterrompido);
            if (!madeiraColetada) return false;

            tronco = bot.inventory.items().find(item =>
                tiposMadeira.ehMadeiraBruta(item.name)
            );
            if (!tronco) return false;
        }
        const nomeTabuas = tronco.name.replace(/_(log|stem|hyphae)$/, '_planks');
        const itemTabuas = bot.registry.itemsByName[nomeTabuas];

        if (!itemTabuas) {
            console.log(`Não encontrei tábuas correspondentes a ${tronco.name}.`);
            return false;
        }

        const receita = bot.recipesFor(itemTabuas.id, null, 1, null)[0];
        if (!receita) {
            console.log(`Não encontrei receita para ${nomeTabuas}.`);
            return false;
        }

        await bot.craft(receita, 1, null);
        if (foiInterrompido()) return false;
    }

    return true;
}

async function pegarMadeiraComAsMaos(
    bot,
    goals,
    quantidadeNecessaria = 1,
    foiInterrompido = () => false
) {
    const blocosIgnoradosAte = new Map();
    const tempoIgnorarBlocoMs = 60_000;
    const maxTentativasSemMadeira = 8;
    let tentativasSemMadeira = 0;
    const origemBusca = bot.entity.position.clone();

    function chavePosicao(posicao) {
        return `${posicao.x},${posicao.y},${posicao.z}`;
    }

    function ignorarBloco(posicao) {
        blocosIgnoradosAte.set(
            chavePosicao(posicao),
            Date.now() + tempoIgnorarBlocoMs
        );
    }

    console.log('🌲 Não tenho madeira suficiente.');
    console.log('✋ Vou procurar madeira e quebrar com a mão...');

    while (true) {
        // Não mantém a busca ativa enquanto o bot está morto ou aguardando respawn.
        if (foiInterrompido() || !bot.entity || bot.health <= 0) return false;

        const madeira = bot.findBlock({
            matching: block => {
                if (!block || !block.position || !tiposMadeira.ehMadeiraBruta(block.name)) return false;

                const chave = chavePosicao(block.position);
                const ignoradoAte = blocosIgnoradosAte.get(chave);

                if (ignoradoAte && Date.now() < ignoradoAte) return false;
                blocosIgnoradosAte.delete(chave);
                return true;
            },
            maxDistance: 48
        });

        if (!madeira) {
            tentativasSemMadeira++;
            console.log(`Não encontrei troncos próximos (${tentativasSemMadeira}/${maxTentativasSemMadeira}).`);
            if (tentativasSemMadeira >= maxTentativasSemMadeira) {
                console.log('Vou interromper o crafting por falta de troncos por perto.');
                return false;
            }
            console.log('❌ Não encontrei madeira próxima.');
            if (tentativasSemMadeira % 2 === 0) {
                const indicePonto = Math.floor(tentativasSemMadeira / 2) - 1;
                const angulo = (indicePonto * Math.PI) / 2;
                const raio = indicePonto < 2 ? 16 : 32;
                const x = Math.floor(origemBusca.x + Math.cos(angulo) * raio);
                const z = Math.floor(origemBusca.z + Math.sin(angulo) * raio);
                try {
                    console.log(`Sem troncos por perto; explorando (${x}, ${z}).`);
                    await bot.pathfinder.goto(new goals.GoalXZ(x, z));
                } catch (erro) {
                    if (foiInterrompido()) return false;
                    console.log('Falha ao chegar ao ponto de busca:', erro.message);
                    bot.pathfinder.stop();
                    await esperar(1000);
                }
            } else {
                await esperar(1000);
            }
            continue;
        }

        tentativasSemMadeira = 0;

        console.log('🌲 Madeira encontrada!');
        console.log('Tipo:', madeira.name);
        console.log('Posição:', madeira.position);

        try {

            // Confirma que o bloco ainda existe
            if (!bot.blockAt(madeira.position)) {
                ignorarBloco(madeira.position);
                continue;
            }

            // Vai até a madeira
            await bot.pathfinder.goto(
                new goals.GoalNear(
                    madeira.position.x,
                    madeira.position.y,
                    madeira.position.z,
                    3
                )
            );

            if (foiInterrompido()) return false;

            // Confirma que ainda é madeira
            const blocoAtual = bot.blockAt(madeira.position);

            if (
                !blocoAtual ||
                !tiposMadeira.ehMadeiraBruta(blocoAtual.name)
            ) {
                ignorarBloco(madeira.position);
                continue;
            }

            // Quebra com a mão
            await bot.dig(blocoAtual);

            if (foiInterrompido()) return false;

            console.log('✋ Madeira quebrada com a mão!');

            // Espera o drop aparecer
            await esperar(500);
            if (foiInterrompido()) return false;

            // Pega itens próximos
            await coletarItensProximos(bot, goals);
            if (foiInterrompido()) return false;

            // Conta madeira
            const quantidadeMadeira = contarTroncos(bot);

            console.log(
                `🪵 Madeira no inventário: ${quantidadeMadeira}`
            );

            // Para cada receita, coleta somente a quantidade pedida pelo crafting.
            if (quantidadeMadeira >= quantidadeNecessaria) {

                console.log(
                    '✅ Tenho madeira suficiente!'
                );

                return true;
            }

        } catch (err) {

            console.log(
                '⚠️ Não consegui pegar esta madeira:',
                err.message
            );

            bot.pathfinder.stop();
            bot.stopDigging();

            if (foiInterrompido() || !bot.entity || bot.health <= 0) return false;

            ignorarBloco(madeira.position);
            console.log('Vou ignorar este bloco por 60 segundos e tentar outra madeira.');
        }

        await esperar(500);
    }
}


async function coletarItensProximos(bot, goals) {

    const itens = Object.values(bot.entities).filter(entity =>
        entity.name === 'item' &&
        entity.position.distanceTo(bot.entity.position) <= 8
    );

    for (const item of itens) {

        try {

            await bot.pathfinder.goto(
                new goals.GoalNear(
                    item.position.x,
                    item.position.y,
                    item.position.z,
                    1
                )
            );

        } catch (err) {
            // Se não conseguir pegar, continua
        }
    }
}


async function crafting(bot, Movements, goals) {
    const versaoMorteInicial = obterVersaoDeMorte(bot);
    const foiInterrompido = () =>
        obterVersaoDeMorte(bot) !== versaoMorteInicial ||
        !bot.entity || bot.health <= 0;

    if (foiInterrompido()) return false;
    bot.pathfinder.setMovements(new Movements(bot));

    // =========================================
    // 1. JÁ TEM MACHADO?
    // =========================================

    let machado = await equipamentos.equiparMelhorMachado(bot);

    if (machado) {
        console.log('🪓 Já tenho um machado adequado; não vou criar outro.');

        return true;
    }


    // =========================================
    // 2. PROCURAR BANCADA
    // =========================================

    let bancadaItem = bot.inventory.items().find(item =>
        item.name === 'crafting_table'
    );

    let bancadaBloco = bot.findBlock({
        matching: bot.registry.blocksByName.crafting_table.id,
        maxDistance: 16
    });


    // =========================================
    // 4. SE NÃO TEM BANCADA
    // =========================================

    if (!bancadaItem && !bancadaBloco) {

        console.log('🛠️ Não tenho bancada.');

        if (!(await criarTabuas(bot, goals, 4, foiInterrompido))) return false;
        if (foiInterrompido()) return false;

        console.log('🛠️ Criando bancada...');

        const receitaBancada = bot.recipesFor(
            bot.registry.itemsByName.crafting_table.id,
            null,
            1,
            null
        )[0];

        if (!receitaBancada) {

            console.log(
                '❌ Ainda não consigo criar a bancada.'
            );

            return false;
        }

        await bot.craft(
            receitaBancada,
            1,
            null
        );
        if (foiInterrompido()) return false;

        bancadaItem = await esperarItemNoInventario(bot, 'crafting_table');
        if (!bancadaItem) {
            const itensInventario = bot.inventory.items()
                .map(item => `${item.name} x${item.count}`)
                .join(', ') || '(vazio)';

            console.log(
                '❌ O craft terminou, mas a bancada não apareceu no inventário. Itens atuais:',
                itensInventario
            );
            return false;
        }

        console.log(
            '🛠️ Bancada criada!'
        );


    }


    // =========================================
    // 5. SE NÃO TEM BANCADA NO MUNDO,
    //    COLOCAR A BANCADA
    // =========================================

    bancadaBloco = bot.findBlock({
        matching: bot.registry.blocksByName.crafting_table.id,
        maxDistance: 16
    });

    if (!bancadaBloco) {

        console.log(
            '🛠️ Preciso colocar a bancada no chão.'
        );

        const posicaoBot =
            bot.entity.position.floored();

        let blocoBase = null;

        for (let x = -3; x <= 3; x++) {

            for (let y = -2; y <= 1; y++) {

                for (let z = -3; z <= 3; z++) {

                    const bloco = bot.blockAt(
                        posicaoBot.offset(x, y, z)
                    );

                    if (!bloco) continue;

                    if (
                        bloco.name === 'air' ||
                        bloco.name === 'water' ||
                        bloco.name === 'lava'
                    ) {
                        continue;
                    }

                    const espacoAcima = bot.blockAt(
                        bloco.position.offset(0, 1, 0)
                    );

                    if (
                        espacoAcima &&
                        espacoAcima.name === 'air'
                    ) {

                        blocoBase = bloco;
                        break;
                    }
                }

                if (blocoBase) break;
            }

            if (blocoBase) break;
        }

        if (!blocoBase) {

            console.log(
                '❌ Não encontrei lugar para colocar a bancada.'
            );

            return false;
        }

        // Atualiza a referência após o crafting e confirma que o item existe.
        bancadaItem = bancadaItem ||
            await esperarItemNoInventario(bot, 'crafting_table', 2);

        if (!bancadaItem) {
            console.log('❌ A bancada não está no inventário para ser colocada.');
            return false;
        }

        const posicaoBancada = blocoBase.position.offset(0, 1, 0);

        try {
            await bot.equip(bancadaItem, 'hand');
            if (foiInterrompido()) return false;

            await bot.placeBlock(
                blocoBase,
                new Vec3(0, 1, 0)
            );

            console.log(
                '🛠️ Bancada colocada no chão!'
            );

        } catch (err) {

            console.log(
                '❌ Não consegui colocar a bancada:',
                err.message
            );

            return false;
        }

        await esperar(500);

        bancadaBloco = bot.blockAt(posicaoBancada);

        if (!bancadaBloco || bancadaBloco.name !== 'crafting_table') {
            bancadaBloco = bot.findBlock({
                matching: bot.registry.blocksByName.crafting_table.id,
                maxDistance: 16
            });
        }

        if (!bancadaBloco || bancadaBloco.name !== 'crafting_table') {
            console.log('❌ Coloquei a bancada, mas não consegui confirmar o bloco no mundo.');
            return false;
        }
    }


    // =========================================
    // 6. VERIFICAR MACHADO NOVAMENTE
    // =========================================

    machado = bot.inventory.items().find(item =>
        item.name.includes('axe')
    );

    if (machado) {

        console.log(
            '🪓 Já tenho um machado! Não vou criar outro.'
        );

        await bot.equip(
            machado,
            'hand'
        );

        console.log('🪓 Machado equipado!');

        return true;
    }


    // =========================================
    // 7. PREPARAR APENAS O QUE A RECEITA DO MACHADO AINDA EXIGE
    // Machado de madeira: 3 tábuas e 2 gravetos.
    const idGraveto = bot.registry.itemsByName.stick.id;
    const gravetosAtuais = contarItem(bot, 'stick');
    const tabuasNecessarias = 3 + (gravetosAtuais < 2 ? 2 : 0);

    console.log(`Materiais atuais: ${contarTabuas(bot)} tábua(s), ${gravetosAtuais} graveto(s).`);
    console.log(`Vou garantir ${tabuasNecessarias} tábuas para completar as receitas.`);

    if (!(await criarTabuas(bot, goals, tabuasNecessarias, foiInterrompido))) return false;
    if (foiInterrompido()) return false;

    if (gravetosAtuais < 2) {
        const receitaGravetos = bot.recipesFor(
            idGraveto,
            null,
            1,
            null
        )[0];

        if (!receitaGravetos) {
            console.log('Não encontrei uma receita de gravetos possível com os materiais atuais.');
            return false;
        }

        // Uma execução produz quatro gravetos; só cria se faltarem gravetos.
        await bot.craft(receitaGravetos, 1, null);
        if (foiInterrompido()) return false;
        console.log('Gravetos criados para completar a receita do machado.');
    }

    // 10. RECEITA DO MACHADO
    // =========================================

    const idMachado =
        bot.registry.itemsByName.wooden_axe.id;

    const receitas = bot.recipesFor(
        idMachado,
        null,
        1,
        bancadaBloco
    );

    console.log(
        '🔎 Receitas de machado encontradas:',
        receitas.length
    );

    if (receitas.length === 0) {

        console.log(
            `Inventário para o machado: ${contarTabuas(bot)} tábua(s), ${contarItem(bot, 'stick')} graveto(s); bancada: ${bancadaBloco ? bancadaBloco.name : 'não encontrada'}.`
        );

        console.log(
            '❌ Não encontrei a receita do machado.'
        );

        return false;
    }


    // =========================================
    // 11. CRIAR MACHADO
    // =========================================

    if (foiInterrompido()) return false;

    // A bancada pode estar dentro do raio de busca, mas longe demais para abrir.
    try {
        bot.pathfinder.setMovements(new Movements(bot));
        const posicaoBancada = bancadaBloco.position;

        await bot.pathfinder.goto(
            new goals.GoalNear(
                posicaoBancada.x,
                posicaoBancada.y,
                posicaoBancada.z,
                2
            )
        );

        if (foiInterrompido()) return false;

        bancadaBloco = bot.blockAt(posicaoBancada);
        if (!bancadaBloco || bancadaBloco.name !== 'crafting_table') {
            bancadaBloco = bot.findBlock({
                matching: bot.registry.blocksByName.crafting_table.id,
                maxDistance: 4
            });
        }

        if (!bancadaBloco || bancadaBloco.name !== 'crafting_table') {
            console.log('Não consegui confirmar uma bancada perto o bastante para fabricar o machado.');
            return false;
        }
    } catch (err) {
        if (foiInterrompido()) return false;
        console.log('Não consegui chegar até a bancada:', err.message);
        return false;
    }

    await bot.craft(
        receitas[0],
        1,
        bancadaBloco
    );
    if (foiInterrompido()) return false;

    console.log(
        '🪓 Machado de madeira criado!'
    );


    // =========================================
    // 12. EQUIPAR MACHADO
    // =========================================

    machado = await equipamentos.equiparMelhorMachado(bot);

    if (machado) {
        return true;
    }

    return false;
}


crafting.interromper = interromper;

module.exports = crafting;
