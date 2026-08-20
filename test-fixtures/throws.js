// Bug: getUser returns undefined for unknown ids and the caller does not
// check, so accessing .name throws an uncaught TypeError.
function getUser(id) {
    const users = { 1: { name: 'ada' } };
    return users[id];
}

const user = getUser(2);
console.log(user.name.toUpperCase());
