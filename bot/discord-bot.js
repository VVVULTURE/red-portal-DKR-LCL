'use strict';

/**
 * Red Portal — Discord gateway bot (merged into the pipeline process)
 * =====================================================================
 * Formerly a separate always-on process (Red-Portal-Agent) that queued
 * /request submissions for this bot to poll every 30s. Now that this
 * process itself owns the pipeline, there's nothing to poll — the
 * slash-command handler runs the pipeline directly, the same way the
 * website's /post-request handler in bot.js already does.
 *
 * The embed/reaction/reply behavior below is intentionally unchanged
 * from the old agent so the bot's output in Discord looks identical.
 */

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActivityType,
} = require('discord.js');

const { BOT_TOKEN, REQUEST_CHANNEL_ID, GUILD_ID } = require('./config');
const { runPipeline } = require('./pipeline');
const { notifyInfo } = require('./discord');

const commands = [
  new SlashCommandBuilder()
    .setName('request')
    .setDescription('Submit a game or service request to Red Portal')
    .addStringOption(opt =>
      opt.setName('name')
         .setDescription('Name of the game or service')
         .setRequired(true)
         .setMaxLength(120)
    )
    .addStringOption(opt =>
      opt.setName('type')
         .setDescription('What kind of request is this?')
         .setRequired(false)
         .addChoices(
           { name: '🎮 Game',              value: 'Game'    },
           { name: '🌐 Service / Proxy',   value: 'Service' },
           { name: '💬 Other',             value: 'Other'   },
         )
    )
    .addStringOption(opt =>
      opt.setName('notes')
         .setDescription('Any extra details or links (optional)')
         .setRequired(false)
         .setMaxLength(500)
    ),
].map(cmd => cmd.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  try {
    console.log('  📡  Registering slash commands…');
    await rest.put(Routes.applicationGuildCommands(
      Buffer.from(BOT_TOKEN.split('.')[0], 'base64').toString('utf8'),
      GUILD_ID,
    ), { body: commands });
    console.log('  ✓   Slash commands registered.');
  } catch (err) {
    console.error('  ✗   Failed to register commands:', err.message);
  }
}

function buildRequestEmbed({ name, type, notes, submitter, avatarUrl }) {
  const typeEmoji = { Game: '🎮', Service: '🌐', Other: '💬' }[type] || '📨';

  const embed = new EmbedBuilder()
    .setTitle(`${typeEmoji} New ${type || 'Request'} Request`)
    .setColor(0xFF2020)
    .addFields(
      { name: 'Game / Service', value: name,                         inline: false },
      { name: 'Type',           value: type || 'Game',               inline: true  },
      { name: 'Submitted by',   value: submitter || 'Anonymous',     inline: true  },
    )
    .setTimestamp()
    .setFooter({ text: 'Red Portal · Request System' });

  if (notes) embed.addFields({ name: 'Notes', value: notes, inline: false });
  if (avatarUrl) embed.setThumbnail(avatarUrl);

  return embed;
}

async function postRequestEmbed(client, data) {
  const channel = await client.channels.fetch(REQUEST_CHANNEL_ID).catch(() => null);
  if (!channel) throw new Error('Could not find requests channel — check REQUEST_CHANNEL_ID');

  const msg = await channel.send({ embeds: [buildRequestEmbed(data)] });
  await msg.react('✅');
  await msg.react('❌');

  return msg;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ],
});

client.once('ready', async () => {
  console.log(`  🤖  Discord bot logged in as: ${client.user.tag}`);
  console.log(`  📬  Requests channel ID: ${REQUEST_CHANNEL_ID}`);

  client.user.setActivity('Red Portal requests', { type: ActivityType.Watching });

  await registerCommands();
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'request') return;

  console.log(`  📨  /request received from ${interaction.user.username} (interaction id: ${interaction.id})`);

  const name      = interaction.options.getString('name', true).trim();
  const type      = interaction.options.getString('type')  || 'Game';
  const notes     = interaction.options.getString('notes') || null;
  const submitter = interaction.user.username;
  const avatarUrl = interaction.user.displayAvatarURL({ size: 64 });

  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (err) {
    console.error(`  ✗  deferReply failed for "${name}" (interaction id: ${interaction.id}): ${err.message}`);
    console.error(`     This usually means Discord already considers the interaction expired/used —`);
    console.error(`     often caused by more than one bot process running with the same token.`);
    return;
  }

  try {
    await postRequestEmbed(client, { name, type, notes, submitter, avatarUrl });
    await interaction.editReply({ content: `✅ Request submitted! **${name}** has been posted to the requests channel.` });
  } catch (err) {
    console.error('  ✗  Failed to post request embed:', err.message);
    try {
      await interaction.editReply({ content: `⚠ Something went wrong posting your request. Try again later.` });
    } catch (editErr) {
      console.error('  ✗  Also failed to send error reply:', editErr.message);
    }
    return;
  }

  // Run the pipeline directly — no queue, no polling, this process does it all.
  runPipeline({ name, type, notes, submitter }).catch(err => {
    console.error(`  ✗  Unhandled pipeline error for "${name}":`, err);
    notifyInfo(`❌ Unhandled pipeline error for **${name}**: ${err.message}`).catch(() => {});
  });
});

client.on('error', err => console.error('  ✗  Discord client error:', err.message));

function start() {
  return client.login(BOT_TOKEN).catch(err => {
    console.error('\n  ✗  Discord login failed:', err.message);
    console.error('     Check that BOT_TOKEN is correct.\n');
    throw err;
  });
}

module.exports = { start };
