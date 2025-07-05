require('dotenv').config();

const CLIENT_ID = process.env.CLIENT_ID || 'YOUR_CLIENT_ID_HERE';

// Administrator permission flag
const ADMINISTRATOR = 0x8;

// Generate invite URL with admin permissions
const inviteURL = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&permissions=${ADMINISTRATOR}&scope=bot%20applications.commands`;

console.log('Bot Invite URL with Administrator permissions:');
console.log(inviteURL);
console.log('\nMake sure to set CLIENT_ID in your .env file!');