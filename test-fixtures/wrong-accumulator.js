// Bug: count accumulates the value instead of incrementing by one, so the
// mean is wrong for any input where values differ from 1.
function computeStats(values) {
    let sum = 0;
    let count = 0;
    for (const v of values) {
        sum += v;
        count += v;
    }
    return { mean: sum / count, count };
}

const stats = computeStats([10, 20, 30]);
console.log('mean =', stats.mean, 'count =', stats.count);
