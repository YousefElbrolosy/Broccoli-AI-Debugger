// Bug: loop condition uses <= so the last iteration reads past the array end,
// making total NaN.
function sumArray(arr) {
    let total = 0;
    for (let i = 0; i <= arr.length; i++) {
        total += arr[i];
    }
    return total;
}

const nums = [3, 7, 11, 2];
const result = sumArray(nums);
console.log('sum =', result);
