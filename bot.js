// ═══════════════════════════════════════════════════════════
// Arbix Discord Bot — v1.3
//   • Script-only verification (started from ArbixOS)
//   • DM confirmation with Verify / Not-Me buttons
//   • API-key authenticated endpoints
//   • Admin slash commands: /ban /unban /mute /unmute /role
// ═══════════════════════════════════════════════════════════

const {
    Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
    ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
    ActivityType, Events, Partials
} = require("discord.js");
const express = require("express");
const crypto = require("crypto");

// ─── Config from environment ───
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const PORT = process.env.PORT || 3000;
const PREFIX = "!";

// ─── 🔑 THE API KEY ───
// Set via Railway/Replit env var called API_KEY.
const API_KEY = process.env.API_KEY || "36b3e842-f611-4c3e-b131-3d60811f8fe2";

// Optional: set GUILD_ID for instant slash command registration
const GUILD_ID = process.env.GUILD_ID || "";

if (!BOT_TOKEN) {
    console.error("Missing DISCORD_BOT_TOKEN");
    process.exit(1);
}
if (API_KEY === "CHANGE_ME_TO_A_LONG_RANDOM_STRING") {
    console.warn("[WARN] API_KEY is still the default placeholder — change it!");
}

// ─── In-memory stores ───
const pendingVerifications = new Map();
const pendingAvatarUploads = new Map();
const userAvatars          = new Map();
const verifiedUsers        = new Map();
const sessions             = new Map();

const AVATAR_PROMPT_TTL = 5 * 60 * 1000;
const VERIFY_TTL        = 10 * 60 * 1000;

const ROLE_RANK = { Banned: -1, User: 0, VIP: 1, Staff: 2, Mod: 3, Admin: 4, Owner: 5 };

// ─── Discord client ───
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
        new SlashCommandBuilder()
            .setName("avatar")
            .setDescription("Set your Arbix chat avatar (verified users only)")
            .addStringOption(o => o.setName("url").setDescription("Direct image URL").setRequired(false))
            .toJSON(),
        new SlashCommandBuilder()
            .setName("help")
            .setDescription("How to use the Arbix bot")
            .toJSON(),
        new SlashCommandBuilder()
            .setName("whoami")
            .setDescription("Show your linked Arbix account")
            .toJSON(),
        // ─── Admin commands ───
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
            .addStringOption(o => o
                .setName("role")
                .setDescription("New role")
                .setRequired(true)
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

// ─── Helpers ───
function generateCode() {
    const chars = "ABCDEFGHIJKLMNPQRSTUVWXYZ23456789";
    let out = "";
    for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
}
function generateToken() {
    return crypto.randomBytes(24).toString("hex");
}
function findArbixByDiscord(discordId) {
    for (const [arbixId, data] of verifiedUsers.entries()) {
        if (data.discordId === discordId) return arbixId;
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
            embeds: [{
                title, color, fields,
                footer: { text: "Arbix Hub" },
                timestamp: new Date().toISOString(),
            }],
        }),
    }).catch(() => {});
}

// ─── Embeds ───
function buildHelpEmbed() {
    return new EmbedBuilder()
        .setTitle("📖 Arbix Bot — How to use")
        .setDescription(
            `**🔐 Verification**\n` +
            `Started **only** from inside ArbixOS.\n` +
            `Open ArbixOS → ⚙ Settings → **Discord Verification** → enter your Discord user ID.\n` +
            `Then press **Verify** in the DM.\n\n` +
            `**🖼️ Avatar** (after verifying)\n` +
            `\`${PREFIX}avatar\` — attach an image\n` +
            `\`${PREFIX}avatar <imageURL>\` — paste a direct link\n` +
            `\`/avatar url:<link>\` — slash version\n\n` +
            `**🛡️ Admin (Mod+)**\n` +
            `\`/ban <username> [duration] [reason]\`\n` +
            `\`/unban <username>\`\n` +
            `\`/mute <username> [duration]\`\n` +
            `\`/unmute <username>\`\n` +
            `\`/role <username> <role>\`  (Owner only)\n\n` +
            `Durations: \`30s\`, \`5m\`, \`2h\`, \`1d\`, or \`perm\`\n\n` +
            `**ℹ️ Info**\n` +
            `\`${PREFIX}help\` · \`${PREFIX}whoami\` · \`${PREFIX}unverify\``
        )
        .setColor(0x5865F2)
        .setFooter({ text: "Arbix Hub — Bot Guide" })
        .setTimestamp();
}

function buildPostVerifyEmbed(arbixUserId) {
    const alreadySet = userAvatars.has(arbixUserId);
    return new EmbedBuilder()
        .setTitle("✅ Verified Successfully")
        .setDescription(
            `Your Discord is now linked to Arbix account **\`${arbixUserId}\`**.\n\n` +
            `Head back to ArbixOS — the app is already polling and will confirm shortly.\n\n` +
            `**🎨 Set your chat avatar**\n` +
            `• \`${PREFIX}avatar\` with an image attached\n` +
            `• \`${PREFIX}avatar https://example.com/image.png\`\n\n` +
            (alreadySet
                ? `**Your current avatar is already set.** Run \`${PREFIX}avatar\` again to replace it.`
                : `**You don't have an avatar set yet.** Run \`${PREFIX}avatar\` to add one.`)
        )
        .setColor(0x57F287)
        .setFooter({ text: "Arbix Hub — Verified" })
        .setTimestamp();
}

// ─── Verification DM ───
async function openVerificationDM(discordId, arbixUserId) {
    const user = await client.users.fetch(discordId);
    const code = generateCode();
    const token = generateToken();

    pendingVerifications.set(discordId, {
        arbixUserId, code, token,
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
            `**Verification Code:**\n\`\`\`${code}\`\`\`\n` +
            `If this is you, press **Verify**. Otherwise press **It's Not Me**.`
        )
        .setColor(0x5865F2)
        .setFooter({ text: "Expires in 10 minutes" })
        .setTimestamp();

    const helpEmbed = new EmbedBuilder()
        .setTitle("📖 What happens next?")
        .setDescription(
            "**1. Click Verify** — links your Discord to your Arbix account\n" +
            "**2. Set your avatar** — run `!avatar` with an image attached\n" +
            "**3. Chat in-game** — open ArbixOS → Chat\n\n" +
            "Type `!help` anytime to see all commands."
        )
        .setColor(0x57F287);

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

    await user.send({ embeds: [verifyEmbed, helpEmbed], components: [row] });
    return { code, token };
}

// ─── Interactions ───
client.on(Events.InteractionCreate, async (interaction) => {
    // ── Slash commands ──
    if (interaction.isChatInputCommand()) {
        const name = interaction.commandName;

        // /avatar
        if (name === "avatar") {
            const url = interaction.options.getString("url");
            const arbixId = findArbixByDiscord(interaction.user.id);
            if (!arbixId) {
                return interaction.reply({
                    content: "✕ You need to verify first — open ArbixOS → Settings → Discord Verification.",
                    ephemeral: true,
                });
            }
            if (!url) {
                pendingAvatarUploads.set(interaction.user.id, Date.now() + AVATAR_PROMPT_TTL);
                return interaction.reply({
                    content: `🖼️ **Send the image here.**\n\nJust upload it in this DM or type \`${PREFIX}avatar\` with an image attached.`,
                    ephemeral: true,
                });
            }
            if (!/^https?:\/\/.+/i.test(url)) {
                return interaction.reply({ content: "✕ Invalid image URL.", ephemeral: true });
            }
            userAvatars.set(arbixId, url);
            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle("🖼️ Avatar Set")
                        .setDescription(`Your new chat avatar is now active for **\`${arbixId}\`**.`)
                        .setThumbnail(url)
                        .setColor(0x57F287)
                ],
                ephemeral: true,
            });
        }

        // /help
        if (name === "help") {
            return interaction.reply({ embeds: [buildHelpEmbed()], ephemeral: true });
        }

        // /whoami
        if (name === "whoami") {
            const arbixId = findArbixByDiscord(interaction.user.id);
            if (!arbixId) {
                return interaction.reply({
                    content: "You are not verified. Open ArbixOS → Settings → Discord Verification.",
                    ephemeral: true,
                });
            }
            const data = verifiedUsers.get(arbixId);
            const avatar = userAvatars.get(arbixId);
            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle("👤 Your Linked Account")
                        .addFields(
                            { name: "Arbix ID", value: `\`${arbixId}\``, inline: true },
                            { name: "Discord", value: `<@${data.discordId}>`, inline: true },
                            { name: "Verified", value: `<t:${Math.floor(data.verifiedAt / 1000)}:R>`, inline: false },
                            { name: "Avatar", value: avatar ? `[Link](${avatar})` : "*not set*", inline: false }
                        )
                        .setColor(0x5869F2)
                        .setThumbnail(avatar || null)
                ],
                ephemeral: true,
            });
        }

        // ── Admin commands ──
        const adminCmds = ["ban", "unban", "mute", "unmute", "role"];
        if (adminCmds.includes(name)) {
            const rank = getAdminRank(interaction.user.id);
            if (rank < ROLE_RANK.Mod) {
                return interaction.reply({
                    content: "✕ You don't have permission (requires Mod+).",
                    ephemeral: true,
                });
            }
            if (name === "role" && rank < ROLE_RANK.Owner) {
                return interaction.reply({ content: "✕ Requires Owner.", ephemeral: true });
            }

            const username = interaction.options.getString("username");
            const duration = interaction.options.getString("duration");
            const reason   = interaction.options.getString("reason") || "No reason given";
            const newRole  = interaction.options.getString("role");

            let reply = "";
            let color = 0xED4245;
            let title = "";

            if (name === "ban") {
                const secs = parseDurationToSeconds(duration);
                reply = `🔨 Ban request for **${username}** (${secs ? secs + "s" : "permanent"}).`;
                title = "🔨 Ban Request";
                sendDiscordWebhook(title, color, [
                    { name: "Target",   value: `\`${username}\``, inline: true },
                    { name: "By",       value: `<@${interaction.user.id}>`, inline: true },
                    { name: "Duration", value: `\`${duration || "perm"}\``, inline: true },
                    { name: "Reason",   value: reason, inline: false },
                ]);
            } else if (name === "unban") {
                reply = `✅ Unban request for **${username}**.`;
                color = 0x57F287;
                sendDiscordWebhook("✅ Unban Request", color, [
                    { name: "Target", value: `\`${username}\``, inline: true },
                    { name: "By",     value: `<@${interaction.user.id}>`, inline: true },
                ]);
            } else if (name === "mute") {
                const secs = parseDurationToSeconds(duration);
                reply = `🔇 Mute request for **${username}** (${secs ? secs + "s" : "permanent"}).`;
                color = 0xFFAA00;
                sendDiscordWebhook("🔇 Mute Request", color, [
                    { name: "Target",   value: `\`${username}\``, inline: true },
                    { name: "By",       value: `<@${interaction.user.id}>`, inline: true },
                    { name: "Duration", value: `\`${duration || "perm"}\``, inline: true },
                ]);
            } else if (name === "unmute") {
                reply = `🔊 Unmute request for **${username}**.`;
                color = 0x57F287;
                sendDiscordWebhook("🔊 Unmute Request", color, [
                    { name: "Target", value: `\`${username}\``, inline: true },
                    { name: "By",     value: `<@${interaction.user.id}>`, inline: true },
                ]);
            } else if (name === "role") {
                reply = `⬆ Role change: **${username}** → **${newRole}**.`;
                color = 0x8CEBBF;
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

    // ── Buttons ──
    if (interaction.isButton()) {
        const parts = interaction.customId.split(":");
        const action = parts[0];
        const arbixUserId = parts[1];
        const token = parts[2];

        const pending = pendingVerifications.get(interaction.user.id);
        if (!pending || pending.token !== token || pending.arbixUserId !== arbixUserId) {
            return interaction.reply({
                content: "✕ This verification has expired or is invalid.",
                ephemeral: true,
            });
        }

        if (action === "verify_yes") {
            verifiedUsers.set(arbixUserId, {
                discordId: interaction.user.id,
                discordTag: interaction.user.tag,
                verifiedAt: Date.now(),
            });
            sessions.set(token, {
                arbixUserId,
                discordId: interaction.user.id,
                createdAt: Date.now(),
            });
            pendingVerifications.delete(interaction.user.id);

            await interaction.update({
                embeds: [buildPostVerifyEmbed(arbixUserId)],
                components: [],
            });

            sendDiscordWebhook("✅ User Verified (via ArbixOS)", 0x57F287, [
                { name: "Arbix ID", value: `\`${arbixUserId}\``, inline: true },
                { name: "Discord",  value: `<@${interaction.user.id}>`, inline: false },
                { name: "Time",     value: `\`${new Date().toISOString()}\``, inline: true },
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

// ─── Prefix commands ───
client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;

    const promptExpiry = pendingAvatarUploads.get(message.author.id);
    const wasWaitingForAvatar = promptExpiry && promptExpiry > Date.now();
    if (promptExpiry && promptExpiry <= Date.now()) pendingAvatarUploads.delete(message.author.id);

    const hasImage = message.attachments.some(a =>
        (a.contentType || "").startsWith("image/") ||
        /\.(png|jpe?g|gif|webp)$/i.test(a.name || "")
    );

    if (wasWaitingForAvatar && hasImage && !message.content.startsWith(PREFIX)) {
        pendingAvatarUploads.delete(message.author.id);
        const arbixId = findArbixByDiscord(message.author.id);
        if (!arbixId) return message.reply("✕ You need to verify first.");
        const attachment = message.attachments.find(a =>
            (a.contentType || "").startsWith("image/") ||
            /\.(png|jpe?g|gif|webp)$/i.test(a.name || "")
        );
        if (!attachment) return message.reply("✕ No valid image found.");
        userAvatars.set(arbixId, attachment.url);
        return message.reply({
            embeds: [
                new EmbedBuilder()
                    .setTitle("🖼️ Avatar Updated")
                    .setDescription(`Your new avatar is now active for **\`${arbixId}\`**.`)
                    .setThumbnail(attachment.url)
                    .setColor(0x57F287)
                    .setTimestamp()
            ]
        });
    }

    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const cmd = (args.shift() || "").toLowerCase();
    const rest = args.join(" ");

    if (cmd === "help") return message.reply({ embeds: [buildHelpEmbed()] });

    if (cmd === "verify") {
        return message.reply(
            "✕ Verification can only be started from inside ArbixOS.\n" +
            "Open ArbixOS → ⚙ Settings → **Discord Verification**."
        );
    }

    if (cmd === "avatar") {
        const arbixId = findArbixByDiscord(message.author.id);
        if (!arbixId) {
            return message.reply("✕ You need to verify first — open ArbixOS → Settings → Discord Verification.");
        }

        if (rest && /^https?:\/\//i.test(rest)) {
            userAvatars.set(arbixId, rest);
            return message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle("🖼️ Avatar Set")
                        .setDescription(`Your new chat avatar is now active for **\`${arbixId}\`**.`)
                        .setThumbnail(rest)
                        .setColor(0x57F287)
                        .setTimestamp()
                ]
            });
        }

        const attachment = message.attachments.find(a =>
            (a.contentType || "").startsWith("image/") ||
            /\.(png|jpe?g|gif|webp)$/i.test(a.name || "")
        );
        if (attachment) {
            userAvatars.set(arbixId, attachment.url);
            return message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle("🖼️ Avatar Updated")
                        .setDescription(`Your new chat avatar is now active for **\`${arbixId}\`**.`)
                        .setThumbnail(attachment.url)
                        .setColor(0x57F287)
                        .setTimestamp()
                ]
            });
        }

        pendingAvatarUploads.set(message.author.id, Date.now() + AVATAR_PROMPT_TTL);
        return message.reply({
            embeds: [
                new EmbedBuilder()
                    .setTitle("🖼️ Send Your Avatar")
                    .setDescription(
                        `**Send the image here** — upload it as an attachment in your next message.\n\n` +
                        `Or paste a direct image URL:\n\`${PREFIX}avatar https://example.com/image.png\`\n\n` +
                        `*Supported formats: PNG · JPG · GIF · WebP*`
                    )
                    .setColor(0x5865F2)
            ]
        });
    }

    if (cmd === "whoami") {
        const arbixId = findArbixByDiscord(message.author.id);
        if (!arbixId) {
            return message.reply("You are not verified. Open ArbixOS → Settings → Discord Verification.");
        }
        const data = verifiedUsers.get(arbixId);
        const avatar = userAvatars.get(arbixId);
        return message.reply({
            embeds: [
                new EmbedBuilder()
                    .setTitle("👤 Your Linked Account")
                    .addFields(
                        { name: "Arbix ID", value: `\`${arbixId}\``, inline: true },
                        { name: "Discord", value: `<@${data.discordId}>`, inline: true },
                        { name: "Verified", value: `<t:${Math.floor(data.verifiedAt / 1000)}:R>`, inline: false },
                        { name: "Avatar", value: avatar ? `[Link](${avatar})` : "*not set — run `!avatar`*", inline: false }
                    )
                    .setColor(0x5869F2)
                    .setThumbnail(avatar || null)
            ]
        });
    }

    if (cmd === "unverify") {
        const arbixId = findArbixByDiscord(message.author.id);
        if (!arbixId) return message.reply("You are not verified.");
        verifiedUsers.delete(arbixId);
        userAvatars.delete(arbixId);
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

// Every route except /health requires the API key
app.use((req, res, next) => {
    if (req.path === "/health") return next();
    const key = req.headers["x-api-key"];
    if (key !== API_KEY) return res.status(401).json({ error: "unauthorized" });
    next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));

// Roblox → bot: start verification DM
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
            sessions.set(token, {
                arbixUserId, discordId, createdAt: Date.now(), preVerified: true,
            });
            return res.json({ ok: true, alreadyVerified: true, token });
        }
        return res.status(409).json({ error: "arbixUserId already linked to a different Discord account" });
    }

    try {
        const { code, token } = await openVerificationDM(String(discordId), String(arbixUserId));
        console.log(`[verify/request] DM sent to ${discordId} for ${arbixUserId}${arbixUsername ? " (" + arbixUsername + ")" : ""}`);
        res.json({ ok: true, token, code });
    } catch (e) {
        console.error("verify/request error:", e);
        res.status(500).json({ error: "could not send DM — check Discord ID and that the bot shares a server with the user" });
    }
});

// Roblox → bot: poll verification status
app.post("/verify/status", (req, res) => {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: "token required" });

    const sess = sessions.get(token);
    if (!sess) return res.json({ status: "invalid" });

    if (sess.preVerified) {
        const avatar = userAvatars.get(sess.arbixUserId) || null;
        return res.json({
            status: "verified",
            discordId: sess.discordId,
            discordTag: sess.discordId,
            avatar,
        });
    }

    const v = verifiedUsers.get(sess.arbixUserId);
    if (!v) {
        const pendingStillThere = [...pendingVerifications.values()].some(
            p => p.token === token && p.expiresAt > Date.now()
        );
        return res.json({ status: pendingStillThere ? "pending" : "expired" });
    }

    const avatar = userAvatars.get(sess.arbixUserId) || null;
    res.json({
        status: "verified",
        discordId: v.discordId,
        discordTag: v.discordTag,
        avatar,
    });
});

// Roblox → bot: get avatar
app.post("/avatar/get", (req, res) => {
    const { arbixUserId } = req.body || {};
    if (!arbixUserId) return res.status(400).json({ error: "arbixUserId required" });
    res.json({ avatar: userAvatars.get(arbixUserId) || null });
});

app.listen(PORT, () => console.log(`[Bot] HTTP API running on port ${PORT}`));

client.login(BOT_TOKEN);
