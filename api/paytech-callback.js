// Alias : certains tableaux de bord PayTech pointent l'IPN vers /api/paytech-callback.
// On réutilise exactement le même traitement sécurisé que /api/paytech-ipn.
module.exports = require('./paytech-ipn.js');
