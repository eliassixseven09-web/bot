// ═══════════════════════════════════════════════════════════
// Arbix Discord Bot — v9.4
//   • Script-only verification (started from ArbixOS)
//   • DM confirmation with Verify / Not-Me buttons
//   • /verify/check so the app can detect unverifies / force-logouts
//   • Admin slash commands: /ban /unban /mute /unmute /role
//   • !dm <hubuser> <message>    — Mod+ DM a linked user
//   • !profile <hubuser>         — view an Arbix profile
//   • !logout <hubuser>          — Mod+ force-unlink a user's Discord
// ═══════════════════════════════════════════════════════════

const {
    Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
    ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
    ActivityType, Events, Partials
} = require("discord.js");
const express = require("express");
const crypto = require("crypto");

const BOT_TOKEN   = process.env.DISCORD_BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const PORT        = process.env.PORT || 3000;
const PREFIX      = "!";
const GUILD_ID    = process.env.GUILD_ID || "";

if (!BOT_TOKEN) {
    console.error("Missing DISCORD_BOT_TOKEN");
    process.exit(1);
}

const pendingVerifications = new Map();
const verifiedUsers        = new Map();
const sessions             = new Map();

const VERIFY_TTL = 10 * 60 * 1000;
const ROLE_RANK  = { Banned: -1, User: 0, VIP: 1, Staff: 2, Mod: 3, Admin: 4, Owner: 5 };

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.User],
});

client.once(Events.ClientReady, async (c) => {
    console.log(`[Bot] Logged in as ${c.user.tag}`);
    c.user.setPresence({
        activities: [{ name: "Arbix Hub · use the iPad app", type: ActivityType.Watching }],
        status: "online",
    });

    const commands = [
        new SlashCommandBuilder().setName("help").setDescription("How to use the Arbix bot").toJSON(),
        new SlashCommandBuilder().setName("whoami").setDescription("Show your linked Arbix account").toJSON(),
        new SlashCommandBuilder()
            .setName("profile")
            .setDescription("Show profile info for an Arbix user")
            .addStringOption(o => o.setName("hubuser").setDescription("Arbix username").setRequired(true))
            .toJSON(),
        new SlashCommandBuilder()
            .setName("dm")
            .setDescription("[Mod+] DM a linked Arbix user through the bot")
            .addStringOption(o => o.setName("hubuser").setDescription("Arbix username").setRequired(true))
            .addStringOption(o => o.setName("message").setDescription("Message to send").setRequired(true))
            .toJSON(),
        new SlashCommandBuilder()
            .setName("logout")
            .setDescription("[Mod+] Force-unlink a user's Discord from their Arbix account")
            .addStringOption(o => o.setName("hubuser").setDescription("Arbix username").setRequired(true))
            .toJSON(),
        new SlashCommandBuilder()
            .setName("ban")
            .setDescription("[Admin] Ban an Arbix user")
            .addStringOption(o => o.setName("username").setDescription("Target Arbix username").setRequired(true))
            .addStringOption(o => o.setName("duration").setDescription("10m / 2h / 1d / perm").setRequired(false))
            .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false))
            .toJSON(),
        new SlashCommandBuilder()
            .setName("unban")
            .setDescription("[Admin] Unban an Arbix user")
            .addStringOption(o => o.setName("username").setDescription("Target Arbix username").setRequired(true))
            .toJSON(),
        new SlashCommandBuilder()
            .setName("mute")
            .setDescription("[Admin] Mute an Arbix user")
            .addStringOption(o => o.setName("username").setDescription("Target Arbix username").setRequired(true))
            .addStringOption(o => o.setName("duration").setDescription("30s / 5m / 1h / perm").setRequired(false))
            .toJSON(),
        new SlashCommandBuilder()
            .setName("unmute")
            .setDescription("[Admin] Unmute an Arbix user")
            .addStringOption(o => o.setName("username").setDescription("Target Arbix username").setRequired(true))
            .toJSON(),
        new SlashCommandBuilder()
            .setName("role")
            .setDescription("[Owner] Change an Arbix user's role")
            .addStringOption(o => o.setName("username").setDescription("Target Arbix username").setRequired(true))
            .addStringOption(o =>
                o.setName("role").setDescription("New role").setRequired(true)
                 .addChoices(
                    { name: "User",  value: "User"  },
                    { name: "VIP",   value: "VIP"   },
                    { name: "Staff", value: "Staff" },
                    { name: "Mod",   value: "Mod"   },
                    { name: "Admin", value: "Admin" },
                 ))
            .toJSON(),
    ];

    const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);
    try {
        if (GUILD_ID) {
            await rest.put(Routes.applicationGuildCommands(c.user.id, GUILD_ID), { body: commands });
        } else {
            await rest.put(Routes.applicationCommands(c.user.id), { body: commands });
        }
        console.log("[Bot] Slash commands registered");
    } catch (e) {
        console.error("Register error:", e);
    }
});

function generateCode() {
    const chars = "ABCDEFGHIJKLMNPQRSTUVWXYZ23456789";
    let out = "";
    for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
}
function generateToken() { return crypto.randomBytes(24).toString("hex"); }

function findArbixByDiscord(discordId) {
    for (const [arbixId, data] of verifiedUsers.entries()) {
        if (data.discordId === discordId) return arbixId;
    }
    return null;
}
function findArbixByUsername(username) {
    if (!username) return null;
    const needle = String(username).toLowerCase();
    for (const [arbixId, data] of verifiedUsers.entries()) {
        if (data.username && data.username.toLowerCase() === needle) return { arbixId, data };
    }
    return null;
}
function getAdminRank(discordId) {
    const arbixId = findArbixByDiscord(discordId);
    if (!arbixId) return -1;
    const v = verifiedUsers.get(arbixId);
    if (!v || !v.role) return 0;
    return ROLE_RANK[v.role] ?? 0;
}
function parseDurationToSeconds(text) {
    if (!text) return null;
    text = String(text).toLowerCase().replace(/\s+/g, "");
    if (text === "perm" || text === "permanent" || text === "") return null;
    const num = parseInt(text.match(/^(\d+)/)?.[1] || "0", 10);
    if (!num) return null;
    const unit = text.match(/\d+([smhd])/)?.[1] || "s";
    return num * ({ s: 1, m: 60, h: 3600, d: 86400 }[unit] || 1);
}
function sendDiscordWebhook(title, color, fields) {
    if (!WEBHOOK_URL) return;
    fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            embeds: [{ title, color, fields, footer: { text: "Arbix Hub" }, timestamp: new Date().toISOString() }],
        }),
    }).catch(() => {});
}

function buildHelpEmbed() {
    return new EmbedBuilder()
        .setTitle("📖 Arbix Bot — How to use")
        .setDescription(
            `**🔐 Verification**\n` +
            `Started **only** from inside ArbixOS.\n` +
            `Open ArbixOS → ⚙ Settings → **Discord Verification** → enter your Discord user ID.\n` +
            `Then press **Verify** in the DM.\n\n` +
            `**🎮 User commands**\n` +
            `\`${PREFIX}profile <hubuser>\` — view an Arbix profile\n` +
            `\`${PREFIX}whoami\` — show your own linked account\n` +
            `\`${PREFIX}unverify\` — unlink your own Discord\n\n` +
            `**🛡️ Admin (Mod+)**\n` +
            `\`${PREFIX}dm <hubuser> <message>\` — DM a user through the bot\n` +
            `\`${PREFIX}logout <hubuser>\` — force-unlink a user's Discord\n` +
            `\`/ban\` · \`/unban\` · \`/mute\` · \`/unmute\` · \`/role\`\n\n` +
            `Durations: \`30s\`, \`5m\`, \`2h\`, \`1d\`, or \`perm\``
        )
        .setColor(0x5865F2)
        .setFooter({ text: "Arbix Hub — Bot Guide" })
        .setTimestamp();
}

function buildPostVerifyEmbed(arbixUserId) {
    return new EmbedBuilder()
        .setTitle("✅ Verified Successfully")
        .setDescription(
            `Your Discord is now linked to Arbix account **\`${arbixUserId}\`**.\n\n` +
            `Head back to ArbixOS — the app is already polling and will confirm shortly.\n\n` +
            `**🎮 Commands**\n` +
            `\`${PREFIX}help\` — see every command\n` +
            `\`${PREFIX}whoami\` — show your linked account\n` +
            `\`${PREFIX}profile <hubuser>\` — view any user's profile\n` +
            `\`${PREFIX}unverify\` — unlink your Discord`
        )
        .setColor(0x57F287)
        .setFooter({ text: "Arbix Hub — Verified" })
        .setTimestamp();
}

function buildProfileEmbed(arbixId, data, discordUser, self) {
    const embed = new EmbedBuilder()
        .setTitle(`👤 Profile — ${data.username || arbixId}`)
        .addFields(
            { name: "Arbix ID",  value: `\`${arbixId}\``,                inline: true },
            { name: "Username",  value: `\`${data.username || "—"}\``,   inline: true },
            { name: "Role",      value: `\`${data.role || "User"}\``,    inline: true },
            { name: "Discord",   value: discordUser ? `<@${discordUser.id}>` : `<@${data.discordId}>`, inline: true },
            { name: "Verified",  value: data.verifiedAt ? `<t:${Math.floor(data.verifiedAt / 1000)}:R>` : "—", inline: true }
        )
        .setColor(0x5869F2)
        .setTimestamp();

    if (discordUser) {
        const avatarURL = discordUser.displayAvatarURL({ size: 256, extension: "png" });
        if (avatarURL) embed.setThumbnail(avatarURL);
        const bannerURL = discordUser.bannerURL({ size: 600, extension: "png" });
        if (bannerURL) embed.setImage(bannerURL);
        embed.setDescription(`Discord: **${discordUser.tag}**${self ? " *(you)*" : ""}`);
    } else {
        embed.setDescription("*Discord user could not be fetched.*");
    }
    return embed;
}

async function fetchDiscordUser(discordId) {
    try { return await client.users.fetch(discordId, { force: true }); }
    catch { return null; }
}

async function openVerificationDM(discordId, arbixUserId, arbixUsername) {
    const user = await client.users.fetch(discordId);
    const code = generateCode();
    const token = generateToken();

    pendingVerifications.set(discordId, {
        arbixUserId, arbixUsername, code, token,
        expiresAt: Date.now() + VERIFY_TTL,
    });

    setTimeout(() => {
        const p = pendingVerifications.get(discordId);
        if (p && p.token === token) pendingVerifications.delete(discordId);
    }, VERIFY_TTL);

    const verifyEmbed = new EmbedBuilder()
        .setTitle("🎮 Arbix Verification Request")
        .setDescription(
            `An Arbix account is trying to link to your Discord.\n\n` +
            `**Arbix User ID:**\n\`\`\`${arbixUserId}\`\`\`\n` +
            (arbixUsername ? `**Username:**\n\`\`\`${arbixUsername}\`\`\`\n` : "") +
            `**Verification Code:**\n\`\`\`${code}\`\`\`\n` +
            `If this is you, press **Verify**. Otherwise press **It's Not Me**.`
        )
        .setColor(0x5865F2)
        .setFooter({ text: "Expires in 10 minutes" })
        .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`verify_yes:${arbixUserId}:${token}`)
            .setLabel("Verify")
            .setStyle(ButtonStyle.Success)
            .setEmoji("✅"),
        new ButtonBuilder()
            .setCustomId(`verify_no:${arbixUserId}:${token}`)
            .setLabel("It's Not Me")
            .setStyle(ButtonStyle.Danger)
            .setEmoji("❌")
    );

    await user.send({ embeds: [verifyEmbed], components: [row] });
    return { code, token };
}

client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand()) {
        const name = interaction.commandName;

        if (name === "help") {
            return interaction.reply({ embeds: [buildHelpEmbed()], ephemeral: true });
        }

        if (name === "whoami") {
            const arbixId = findArbixByDiscord(interaction.user.id);
            if (!arbixId) {
                return interaction.reply({
                    content: "You are not verified. Open ArbixOS → Settings → Discord Verification.",
                    ephemeral: true,
                });
            }
            const data = verifiedUsers.get(arbixId);
            const du = await fetchDiscordUser(data.discordId);
            return interaction.reply({
                embeds: [buildProfileEmbed(arbixId, data, du, true)],
                ephemeral: true,
            });
        }

        if (name === "profile") {
            const target = interaction.options.getString("hubuser");
            const hit = findArbixByUsername(target);
            if (!hit) {
                return interaction.reply({ content: `✕ No linked account found for **${target}**.`, ephemeral: true });
            }
            const du = await fetchDiscordUser(hit.data.discordId);
            return interaction.reply({
                embeds: [buildProfileEmbed(hit.arbixId, hit.data, du, false)],
                ephemeral: true,
            });
        }

        if (name === "dm") {
            const rank = getAdminRank(interaction.user.id);
            if (rank < ROLE_RANK.Mod) {
                return interaction.reply({ content: "✕ Requires Mod+.", ephemeral: true });
            }
            const target = interaction.options.getString("hubuser");
            const message = interaction.options.getString("message");
            const hit = findArbixByUsername(target);
            if (!hit) {
                return interaction.reply({ content: `✕ No linked account found for **${target}**.`, ephemeral: true });
            }
            try {
                const du = await fetchDiscordUser(hit.data.discordId);
                if (!du) throw new Error("fetch failed");
                const dmEmbed = new EmbedBuilder()
                    .setTitle("📬 Message from Arbix Staff")
                    .setDescription(message)
                    .setColor(0x5865F2)
                    .setFooter({ text: `Sent by ${interaction.user.tag}` })
                    .setTimestamp();
                await du.send({ embeds: [dmEmbed] });
                sendDiscordWebhook("📬 DM Sent", 0x5865F2, [
                    { name: "To",      value: `\`${target}\` (${hit.data.discordId})`, inline: true },
                    { name: "From",    value: `<@${interaction.user.id}>`, inline: true },
                    { name: "Message", value: message.slice(0, 1000), inline: false },
                ]);
                return interaction.reply({ content: `✅ DM sent to **${target}**.`, ephemeral: true });
            } catch (e) {
                return interaction.reply({ content: "✕ Could not DM that user (DMs closed or bot not in a shared server).", ephemeral: true });
            }
        }

        if (name === "logout") {
            const rank = getAdminRank(interaction.user.id);
            if (rank < ROLE_RANK.Mod) {
                return interaction.reply({ content: "✕ Requires Mod+.", ephemeral: true });
            }
            const target = interaction.options.getString("hubuser");
            const hit = findArbixByUsername(target);
            if (!hit) {
                return interaction.reply({ content: `✕ No linked account found for **${target}**.`, ephemeral: true });
            }
            const oldDiscordId = hit.data.discordId;
            verifiedUsers.delete(hit.arbixId);
            sendDiscordWebhook("🚪 Force Logout", 0xED4245, [
                { name: "Arbix ID", value: `\`${hit.arbixId}\``, inline: true },
                { name: "Username", value: `\`${hit.data.username || "?"}\``, inline: true },
                { name: "Discord",  value: `<@${oldDiscordId}>`, inline: false },
                { name: "By",       value: `<@${interaction.user.id}>`, inline: false },
            ]);
            return interaction.reply({
                content: `✅ Force-unlinked **${hit.data.username || hit.arbixId}** from <@${oldDiscordId}>. They can re-verify from ArbixOS.`,
                ephemeral: true,
            });
        }

        const adminCmds = ["ban", "unban", "mute", "unmute", "role"];
        if (adminCmds.includes(name)) {
            const rank = getAdminRank(interaction.user.id);
            if (rank < ROLE_RANK.Mod) {
                return interaction.reply({ content: "✕ You don't have permission (requires Mod+).", ephemeral: true });
            }
            if (name === "role" && rank < ROLE_RANK.Owner) {
                return interaction.reply({ content: "✕ Requires Owner.", ephemeral: true });
            }

            const username = interaction.options.getString("username");
            const duration = interaction.options.getString("duration");
            const reason   = interaction.options.getString("reason") || "No reason given";
            const newRole  = interaction.options.getString("role");

            let reply = "", color = 0xED4245;

            if (name === "ban") {
                const secs = parseDurationToSeconds(duration);
                reply = `🔨 Ban request for **${username}** (${secs ? secs + "s" : "permanent"}).`;
                sendDiscordWebhook("🔨 Ban Request", color, [
                    { name: "Target",   value: `\`${username}\``, inline: true },
                    { name: "By",       value: `<@${interaction.user.id}>`, inline: true },
                    { name: "Duration", value: `\`${duration || "perm"}\``, inline: true },
                    { name: "Reason",   value: reason, inline: false },
                ]);
            } else if (name === "unban") {
                reply = `✅ Unban request for **${username}**.`; color = 0x57F287;
                sendDiscordWebhook("✅ Unban Request", color, [
                    { name: "Target", value: `\`${username}\``, inline: true },
                    { name: "By",     value: `<@${interaction.user.id}>`, inline: true },
                ]);
            } else if (name === "mute") {
                const secs = parseDurationToSeconds(duration);
                reply = `🔇 Mute request for **${username}** (${secs ? secs + "s" : "permanent"}).`; color = 0xFFAA00;
                sendDiscordWebhook("🔇 Mute Request", color, [
                    { name: "Target",   value: `\`${username}\``, inline: true },
                    { name: "By",       value: `<@${interaction.user.id}>`, inline: true },
                    { name: "Duration", value: `\`${duration || "perm"}\``, inline: true },
                ]);
            } else if (name === "unmute") {
                reply = `🔊 Unmute request for **${username}**.`; color = 0x57F287;
                sendDiscordWebhook("🔊 Unmute Request", color, [
                    { name: "Target", value: `\`${username}\``, inline: true },
                    { name: "By",     value: `<@${interaction.user.id}>`, inline: true },
                ]);
            } else if (name === "role") {
                reply = `⬆ Role change: **${username}** → **${newRole}**.`; color = 0x8CEBBF;
                sendDiscordWebhook("⬆ Role Change Request", color, [
                    { name: "Target",   value: `\`${username}\``, inline: true },
                    { name: "New Role", value: `\`${newRole}\``, inline: true },
                    { name: "By",       value: `<@${interaction.user.id}>`, inline: true },
                ]);
            }

            return interaction.reply({ content: reply, ephemeral: true });
        }
        return;
    }

    if (interaction.isButton()) {
        const parts = interaction.customId.split(":");
        const action = parts[0];
        const arbixUserId = parts[1];
        const token = parts[2];

        const pending = pendingVerifications.get(interaction.user.id);
        if (!pending || pending.token !== token || pending.arbixUserId !== arbixUserId) {
            return interaction.reply({ content: "✕ This verification has expired or is invalid.", ephemeral: true });
        }

        if (action === "verify_yes") {
            verifiedUsers.set(arbixUserId, {
                discordId:  interaction.user.id,
                discordTag: interaction.user.tag,
                username:   pending.arbixUsername || null,
                verifiedAt: Date.now(),
                role:       "User",
            });
            sessions.set(token, { arbixUserId, discordId: interaction.user.id, createdAt: Date.now() });
            pendingVerifications.delete(interaction.user.id);
            await interaction.update({ embeds: [buildPostVerifyEmbed(arbixUserId)], components: [] });
            sendDiscordWebhook("✅ User Verified (via ArbixOS)", 0x57F287, [
                { name: "Arbix ID", value: `\`${arbixUserId}\``, inline: true },
                { name: "Username", value: `\`${pending.arbixUsername || "?"}\``, inline: true },
                { name: "Discord",  value: `<@${interaction.user.id}>`, inline: false },
            ]);
            return;
        }

        if (action === "verify_no") {
            pendingVerifications.delete(interaction.user.id);
            await interaction.update({
                embeds: [
                    new EmbedBuilder()
                        .setTitle("❌ Verification Declined")
                        .setDescription("No changes were made. You can start a new verification from ArbixOS.")
                        .setColor(0xED4245)
                ],
                components: [],
            });
            sendDiscordWebhook("❌ Verification Declined", 0xED4245, [
                { name: "Arbix ID", value: `\`${arbixUserId}\``, inline: true },
                { name: "Discord",  value: `<@${interaction.user.id}>`, inline: false },
            ]);
            return;
        }
    }
});

client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const cmd = (args.shift() || "").toLowerCase();
    const rest = args.join(" ");

    if (cmd === "help") {
        return message.reply({ embeds: [buildHelpEmbed()] });
    }

    if (cmd === "verify") {
        return message.reply(
            "✕ Verification can only be started from inside ArbixOS.\n" +
            "Open ArbixOS → ⚙ Settings → **Discord Verification**."
        );
    }

    if (cmd === "whoami") {
        const arbixId = findArbixByDiscord(message.author.id);
        if (!arbixId) return message.reply("You are not verified. Open ArbixOS → Settings → Discord Verification.");
        const data = verifiedUsers.get(arbixId);
        const du = await fetchDiscordUser(data.discordId);
        return message.reply({ embeds: [buildProfileEmbed(arbixId, data, du, true)] });
    }

    if (cmd === "profile") {
        if (!rest) return message.reply(`Usage: \`${PREFIX}profile <hubuser>\``);
        const hit = findArbixByUsername(rest);
        if (!hit) return message.reply(`✕ No linked account found for **${rest}**.`);
        const du = await fetchDiscordUser(hit.data.discordId);
        return message.reply({ embeds: [buildProfileEmbed(hit.arbixId, hit.data, du, false)] });
    }

    if (cmd === "dm") {
        const rank = getAdminRank(message.author.id);
        if (rank < ROLE_RANK.Mod) return message.reply("✕ Requires Mod+.");
        const parts = rest.split(/\s+/);
        const target = parts.shift();
        const body = parts.join(" ");
        if (!target || !body) return message.reply(`Usage: \`${PREFIX}dm <hubuser> <message>\``);
        const hit = findArbixByUsername(target);
        if (!hit) return message.reply(`✕ No linked account found for **${target}**.`);
        try {
            const du = await fetchDiscordUser(hit.data.discordId);
            if (!du) throw new Error("no user");
            const dmEmbed = new EmbedBuilder()
                .setTitle("📬 Message from Arbix Staff")
                .setDescription(body)
                .setColor(0x5865F2)
                .setFooter({ text: `Sent by ${message.author.tag}` })
                .setTimestamp();
            await du.send({ embeds: [dmEmbed] });
            sendDiscordWebhook("📬 DM Sent", 0x5865F2, [
                { name: "To",      value: `\`${target}\` (${hit.data.discordId})`, inline: true },
                { name: "From",    value: `<@${message.author.id}>`, inline: true },
                { name: "Message", value: body.slice(0, 1000), inline: false },
            ]);
            return message.reply(`✅ DM sent to **${target}**.`);
        } catch (e) {
            return message.reply("✕ Could not DM that user (DMs closed or bot not in a shared server).");
        }
    }

    if (cmd === "logout") {
        const rank = getAdminRank(message.author.id);
        if (rank < ROLE_RANK.Mod) return message.reply("✕ Requires Mod+.");
        if (!rest) return message.reply(`Usage: \`${PREFIX}logout <hubuser>\``);
        const hit = findArbixByUsername(rest);
        if (!hit) return message.reply(`✕ No linked account found for **${rest}**.`);
        const oldDiscordId = hit.data.discordId;
        verifiedUsers.delete(hit.arbixId);
        sendDiscordWebhook("🚪 Force Logout", 0xED4245, [
            { name: "Arbix ID", value: `\`${hit.arbixId}\``, inline: true },
            { name: "Username", value: `\`${hit.data.username || "?"}\``, inline: true },
            { name: "Discord",  value: `<@${oldDiscordId}>`, inline: false },
            { name: "By",       value: `<@${message.author.id}>`, inline: false },
        ]);
        return message.reply(`✅ Force-unlinked **${hit.data.username || hit.arbixId}** from <@${oldDiscordId}>.`);
    }

    if (cmd === "unverify") {
        const arbixId = findArbixByDiscord(message.author.id);
        if (!arbixId) return message.reply("You are not verified.");
        verifiedUsers.delete(arbixId);
        return message.reply({
            embeds: [
                new EmbedBuilder()
                    .setTitle("🔓 Unverified")
                    .setDescription(`Your Discord has been unlinked from \`${arbixId}\`.`)
                    .setColor(0xED4245)
                    .setTimestamp()
            ]
        });
    }
});

// ═══════════════════════════════════════════════════════════
// HTTP API for the Roblox script
// ═══════════════════════════════════════════════════════════
const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/verify/request", async (req, res) => {
    const { discordId, arbixUserId, arbixUsername } = req.body || {};
    if (!discordId || !arbixUserId) {
        return res.status(400).json({ error: "discordId and arbixUserId required" });
    }
    if (!/^\d{15,25}$/.test(String(discordId))) {
        return res.status(400).json({ error: "discordId must be a numeric Discord user ID" });
    }

    if (verifiedUsers.has(arbixUserId)) {
        const v = verifiedUsers.get(arbixUserId);
        if (String(v.discordId) === String(discordId)) {
            const token = generateToken();
            sessions.set(token, { arbixUserId, discordId, createdAt: Date.now(), preVerified: true });
            return res.json({ ok: true, alreadyVerified: true, token });
        }
        return res.status(409).json({ error: "arbixUserId already linked to a different Discord account" });
    }

    try {
        const { code, token } = await openVerificationDM(String(discordId), String(arbixUserId), arbixUsername);
        console.log(`[verify/request] DM sent to ${discordId} for ${arbixUserId}${arbixUsername ? " (" + arbixUsername + ")" : ""}`);
        res.json({ ok: true, token, code });
    } catch (e) {
        console.error("verify/request error:", e);
        res.status(500).json({ error: "could not send DM" });
    }
});

app.post("/verify/status", (req, res) => {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: "token required" });

    const sess = sessions.get(token);
    if (!sess) return res.json({ status: "invalid" });

    if (sess.preVerified) {
        return res.json({ status: "verified", discordId: sess.discordId, discordTag: sess.discordId });
    }

    const v = verifiedUsers.get(sess.arbixUserId);
    if (!v) {
        const pendingStillThere = [...pendingVerifications.values()].some(p => p.token === token && p.expiresAt > Date.now());
        return res.json({ status: pendingStillThere ? "pending" : "expired" });
    }

    res.json({ status: "verified", discordId: v.discordId, discordTag: v.discordTag });
});

// Roblox → bot: check if this arbixUserId is still verified
app.post("/verify/check", (req, res) => {
    const { arbixUserId } = req.body || {};
    if (!arbixUserId) return res.status(400).json({ error: "arbixUserId required" });
    const v = verifiedUsers.get(arbixUserId);
    if (!v) return res.json({ verified: false });
    res.json({ verified: true, discordId: v.discordId, discordTag: v.discordTag });
});

app.listen(PORT, () => console.log(`[Bot] HTTP API running on port ${PORT}`));

client.login(BOT_TOKEN);
