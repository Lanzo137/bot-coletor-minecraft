const ATRASO_ANALISE_MS = 100;
// Abaixo de 5%, uma alternativa utilizavel tem prioridade sobre a peca critica.
const DURABILIDADE_CRITICA = 0.05;
const ARMADURAS = [
    { tipo: 'capacete', sufixo: '_helmet', slot: 5, destino: 'head' },
    { tipo: 'peitoral', sufixo: '_chestplate', slot: 6, destino: 'torso' },
    { tipo: 'calca', sufixo: '_leggings', slot: 7, destino: 'legs' },
    { tipo: 'botas', sufixo: '_boots', slot: 8, destino: 'feet' }
];
const RANK_MATERIAL = {
    leather: 1,
    wooden: 1,
    wood: 1,
    golden: 2.5,
    gold: 2.5,
    stone: 2,
    chainmail: 3,
    turtle: 3,
    copper: 3.5,
    iron: 4,
    diamond: 5,
    netherite: 6
};

const estadosPorBot = new WeakMap();

// A classificacao usa sufixos para continuar reconhecendo novos materiais do registro.
function classificarEquipamento(item) {
    const nome = item?.name?.split(':').pop();
    if (!nome) return null;

    if (/(^|_)axe$/.test(nome)) return 'machado';
    if (nome === 'shield' || /_shield$/.test(nome)) return 'escudo';

    const armadura = ARMADURAS.find(({ sufixo }) => nome.endsWith(sufixo));
    if (armadura) return armadura.tipo;
    if (nome === 'elytra') return 'peitoral';

    return null;
}

function ehEquipamento(item) {
    return classificarEquipamento(item) !== null;
}

// As propriedades abaixo sao lidas pelo proprio Mineflayer a partir do registro do servidor.
function obterEncantamentos(item) {
    try {
        return Array.isArray(item.enchants) ? item.enchants : [];
    } catch (erro) {
        console.warn(`Nao consegui ler os encantamentos de ${item.name}:`, erro.message);
        return [];
    }
}

function obterDurabilidade(item) {
    const maxima = Number(item.maxDurability);
    if (!Number.isFinite(maxima) || maxima <= 0) return null;

    try {
        const usada = Number(item.durabilityUsed);
        if (!Number.isFinite(usada)) return null;
        return Math.max(0, maxima - usada);
    } catch (erro) {
        console.warn(`Nao consegui ler a durabilidade de ${item.name}:`, erro.message);
        return null;
    }
}

function obterFracaoDurabilidade(item) {
    const maxima = Number(item.maxDurability);
    const restante = obterDurabilidade(item);

    if (!Number.isFinite(maxima) || maxima <= 0 || restante === null) return 1;
    return restante / maxima;
}

function obterRankMaterial(item) {
    const nome = item.name.split(':').pop();
    const material = nome.split('_')[0];
    if (RANK_MATERIAL[material] !== undefined) return RANK_MATERIAL[material];

    // Para materiais novos ou de mods, usa a durabilidade registrada como referência.
    const durabilidade = Number(item.maxDurability);
    return Number.isFinite(durabilidade) && durabilidade > 0
        ? Math.min(7, 1 + Math.log2(durabilidade + 1) / 2)
        : 1;
}

function pontuarEncantamentos(item, categoria) {
    const peso = categoria === 'machado'
        ? { efficiency: 120, unbreaking: 35, mending: 70 }
        : {
            protection: 100,
            fire_protection: 70,
            blast_protection: 70,
            projectile_protection: 70,
            unbreaking: 35,
            mending: 60,
            thorns: 15
        };

    return obterEncantamentos(item).reduce((total, encantamento) => {
        const nome = encantamento.name?.split(':').pop();
        const nivel = Number(encantamento.lvl) || 0;
        return total + (peso[nome] || 0) * nivel;
    }, 0);
}

function pontuarEquipamento(item, categoria) {
    // O material define a base; durabilidade e encantamentos ajustam cada item.
    const rank = obterRankMaterial(item);
    const durabilidade = obterFracaoDurabilidade(item);
    const bonusDurabilidade = durabilidade * 100;
    const bonusEncantamentos = pontuarEncantamentos(item, categoria);

    if (categoria === 'peitoral' && item.name.endsWith('elytra')) {
        return 100 + bonusDurabilidade + bonusEncantamentos;
    }

    return rank * 1000 + bonusDurabilidade + bonusEncantamentos;
}

// Retorna um valor positivo quando o primeiro item e mais adequado para a funcao.
function compararEquipamentos(itemA, itemB, categoria) {
    if (!itemA) return itemB ? -1 : 0;
    if (!itemB) return 1;

    const restanteA = obterDurabilidade(itemA);
    const restanteB = obterDurabilidade(itemB);
    const fracaoA = obterFracaoDurabilidade(itemA);
    const fracaoB = obterFracaoDurabilidade(itemB);

    // Evita gastar uma peça quase quebrada quando há outra em condições de uso.
    if (restanteA === 0 && restanteB !== 0) return -1;
    if (restanteB === 0 && restanteA !== 0) return 1;
    if (fracaoA <= DURABILIDADE_CRITICA && fracaoB > DURABILIDADE_CRITICA) return -1;
    if (fracaoB <= DURABILIDADE_CRITICA && fracaoA > DURABILIDADE_CRITICA) return 1;

    if (
        fracaoA <= DURABILIDADE_CRITICA &&
        fracaoB <= DURABILIDADE_CRITICA &&
        restanteA !== null &&
        restanteB !== null &&
        restanteA !== restanteB
    ) {
        return restanteA > restanteB ? 1 : -1;
    }

    const diferenca = pontuarEquipamento(itemA, categoria) -
        pontuarEquipamento(itemB, categoria);

    return Math.sign(diferenca);
}

function encontrarMelhorItem(bot, categoria, itens = bot.inventory.items()) {
    return itens
        .filter(item => classificarEquipamento(item) === categoria)
        .reduce((melhor, atual) =>
            compararEquipamentos(atual, melhor, categoria) > 0 ? atual : melhor,
        null);
}

// A troca usa os slots de equipamento oficiais do Mineflayer e preserva a peca substituida.
async function equiparSeMelhor(bot, categoria, destino, slot) {
    const melhor = encontrarMelhorItem(bot, categoria);
    const equipado = bot.inventory.slots[slot];

    if (!melhor || compararEquipamentos(melhor, equipado, categoria) <= 0) {
        return false;
    }

    await bot.equip(melhor, destino);
    console.log(`Equipado ${melhor.displayName || melhor.name} como ${categoria}.`);
    return true;
}

async function equiparMelhorMachado(bot) {
    const melhor = encontrarMelhorItem(bot, 'machado');
    if (!melhor) return null;

    const equipado = bot.heldItem;
    const equipadoEhMachado = classificarEquipamento(equipado) === 'machado';
    if (equipado?.slot !== melhor.slot && (
        !equipadoEhMachado ||
        compararEquipamentos(melhor, equipado, 'machado') > 0
    )) {
        await bot.equip(melhor, 'hand');
        console.log(`Machado selecionado: ${melhor.displayName || melhor.name}.`);
    }

    return melhor;
}

async function equiparMelhorArmadura(bot) {
    for (const armadura of ARMADURAS) {
        try {
            await equiparSeMelhor(bot, armadura.tipo, armadura.destino, armadura.slot);
        } catch (erro) {
            console.error(`Falha ao equipar ${armadura.tipo}:`, erro.message);
        }
    }
}

// Uma fila debounced processa as mudancas de inventario sem criar loops por item.
async function analisarInventario(bot) {
    const estado = estadosPorBot.get(bot);
    if (estado?.emAnalise) {
        estado.analisePendente = true;
        return estado.promessa;
    }

    if (estado) estado.emAnalise = true;

    const promessa = (async () => {
        do {
            if (estado) estado.analisePendente = false;
            if (!bot.entity || bot.health <= 0) return;

            try {
                await equiparMelhorMachado(bot);
            } catch (erro) {
                console.error('Falha ao equipar um machado:', erro.message);
            }
            await equiparMelhorArmadura(bot);
        } while (estado?.analisePendente);
    })();

    if (estado) estado.promessa = promessa;

    try {
        await promessa;
    } finally {
        if (estado) estado.emAnalise = false;
    }
}

function agendarAnalise(bot, atrasoMs = ATRASO_ANALISE_MS) {
    const estado = estadosPorBot.get(bot);
    if (!estado) return;

    clearTimeout(estado.temporizador);
    estado.temporizador = setTimeout(() => {
        analisarInventario(bot).catch(erro => {
            console.error('Erro ao analisar o inventario:', erro.message);
        });
    }, atrasoMs);
}

function instalar(bot) {
    if (estadosPorBot.has(bot)) return;

    const estado = {
        emAnalise: false,
        analisePendente: false,
        promessa: Promise.resolve(),
        temporizador: null,
        observandoInventario: false
    };
    estadosPorBot.set(bot, estado);

    function observarInventario() {
        if (estado.observandoInventario) return;

        if (!bot.inventory || typeof bot.inventory.on !== 'function') {
            console.error('O inventario do Mineflayer ainda nao esta disponivel.');
            return;
        }

        estado.observandoInventario = true;

        // Agrupa atualizacoes de slots em uma unica analise para evitar loops concorrentes.
        bot.inventory.on('updateSlot', () => agendarAnalise(bot));
        agendarAnalise(bot, 0);
    }

    // Plugins internos, incluindo inventory, sao injetados depois de createBot retornar.
    if (bot.inventory) {
        observarInventario();
    } else {
        bot.once('inject_allowed', observarInventario);
    }

    bot.on('playerCollect', coletor => {
        if (coletor?.id === bot.entity?.id) agendarAnalise(bot, 50);
    });
    bot.on('spawn', () => agendarAnalise(bot, 250));
}

async function equiparEscudo(bot) {
    // O escudo so vai para a mao secundaria quando uma logica defensiva pedir.
    const escudo = encontrarMelhorItem(bot, 'escudo');
    if (!escudo) return false;

    const escudoEquipado = bot.inventory.slots[45];
    if (escudoEquipado?.slot === escudo.slot) return true;

    await bot.equip(escudo, 'off-hand');
    console.log(`Escudo equipado: ${escudo.displayName || escudo.name}.`);
    return true;
}

module.exports = {
    analisarInventario,
    classificarEquipamento,
    compararEquipamentos,
    ehEquipamento,
    equiparEscudo,
    equiparMelhorArmadura,
    equiparMelhorMachado,
    encontrarMelhorItem,
    instalar
};
