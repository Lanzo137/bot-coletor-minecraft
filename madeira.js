function ehMadeiraBruta(nome) {
    return nome.endsWith('_log') ||
        nome.endsWith('_stem') ||
        nome.endsWith('_hyphae');
}

module.exports = { ehMadeiraBruta };
