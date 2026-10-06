const madeira = require('./madeira');
const equipamentos = require('./equipamentos');

function esperar(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function manterItem(bot, nome) {
    const comida = bot.registry.foodsByName?.[nome];

    return nome === 'stick' ||
        madeira.ehMadeiraBruta(nome) ||
        nome.endsWith('_wood') ||
        nome.endsWith('_planks') ||
        nome.endsWith('_sapling') ||
        nome === 'mangrove_propagule' ||
        Boolean(comida && comida.foodPoints > 0);
}

function contarInventarioPorSlot(bot) {
    const itens = new Map();

    for (const item of bot.inventory.items()) {
        itens.set(item.slot, {
            name: item.name,
            count: item.count
        });
    }

    return itens;
}

function instalarFiltroInventario(bot) {
    let filaDescarte = Promise.resolve();

    bot.on('playerCollect', coletor => {
        if (!bot.entity || coletor?.id !== bot.entity.id) return;

        const antesDaColeta = contarInventarioPorSlot(bot);

        filaDescarte = filaDescarte.then(async () => {
            // Aguarda a atualizacao do inventario enviada apos a coleta.
            await esperar(150);
            if (!bot.entity) return;

            // Primeiro equipa o que acabou de chegar; equipamento nunca vai para o descarte.
            await equipamentos.analisarInventario(bot);
            const processados = new Set();

            for (const item of bot.inventory.items()) {
                if (
                    manterItem(bot, item.name) ||
                    equipamentos.ehEquipamento(item) ||
                    processados.has(item.slot)
                ) continue;

                const itemAntes = antesDaColeta.get(item.slot);
                const pilhaRecebeuItem = !itemAntes ||
                    itemAntes.name !== item.name ||
                    item.count > itemAntes.count;

                if (!pilhaRecebeuItem) continue;

                processados.add(item.slot);

                try {
                    // tossStack solta a pilha inteira, como Ctrl+Q no Minecraft.
                    await bot.tossStack(item);
                    console.log(`Soltei a pilha inteira de ${item.displayName || item.name}.`);
                } catch (erro) {
                    console.log(`Nao consegui soltar ${item.name}:`, erro.message);
                }
            }
        }).catch(erro => {
            console.error('Erro ao filtrar um item coletado:', erro.message);
        });
    });
}

module.exports = instalarFiltroInventario;
