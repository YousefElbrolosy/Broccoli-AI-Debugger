// Bug: loadConfig() is not awaited, so main() reads config before the async
// load finishes and crashes with a TypeError.
let config = null;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function loadConfig() {
    await sleep(50);
    config = { retries: 3 };
}

async function main() {
    loadConfig();
    await sleep(10);
    console.log('retries:', config.retries);
}

main();
