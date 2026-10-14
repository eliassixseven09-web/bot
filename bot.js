// ═══════════════════════════════════════════════════════════
// Arbix Discord Bot — v1.1
// Deploy to Railway / Replit / any Node host that runs 24/7
//
// Required env vars:
//   DISCORD_BOT_TOKEN   = your bot token
//   WEBHOOK_URL         = your webhook (for logging verifies)
//   PORT                = 3000 (default)
//
// Prefix commands (!):
//   !verify [arbixUserId]        — start verification
//   !avatar                      — set avatar (attach image OR reply with image)
//   !avatar <imageURL>           — set avatar from URL
//   !help                        — show all commands
//   !whoami                      — show your linked Arbix account
//   !unverify                    — unlink your Discord
//
// Slash commands (/):
//   /verify, /avatar, /help      — same as above
// ═══════════════════════════════════════════════════════════

const {
    Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
    ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
    ActivityType, Events, Partials
} = require("discord.js");
const express = require("express");

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const PORT = process.env.PORT || 3000;
const PREFIX = "!";

// Change this to your guild ID if you want instant slash command registration
// Leave empty to register globally (takes ~1 hour to propagate)
const GUILD_ID = process.env.GUILD_ID || "";

if (!BOT_TOKEN) {
    console.error("Missing DISCORD_BOT_TOKEN");
    process.exit(1);
}

// ─── In-memory stores ───
const pendingVerifications = new Map();   // discordId -> { arbixUserId, code, expiresAt }
const pendingAvatarUploads = new Map();   // discordId -> true (waiting for image)
const userAvatars = new Map();            // arbixUserId -> avatarURL
const verifiedUsers = new Map();          // arbixUserId -> { discordId, discordTag, verifiedAt }

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

    // Stay online 24/7
    c.user.setPresence({
        activities: [{ name: "Arbix Hub · !help", type: ActivityType.Watching }],
        status: "online",
    });

    // Register slash commands
    const commands = [
        new SlashCommandBuilder()
            .setName("verify")
            .setDescription("Start Arbix account verification")
            .addStringOption(o => o.setName("userid").setDescription("Your Arbix user ID").setRequired(true))
            .toJSON(),
        new SlashCommandBuilder()
            .setName("avatar")
            .setDescription("Set your Arbix chat avatar")
            .addStringOption(o => o.setName("url").setDescription("Direct image URL (or attach a file)").setRequired(false))
            .toJSON(),
        new SlashCommandBuilder()
            .setName("help")
            .setDescription("How to set up and use the Arbix bot")
            .toJSON(),
        new SlashCommandBuilder()
            .setName("whoami")
            .setDescription("Show your linked Arbix account")
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

// ─── The "how to use" embed, reused everywhere ───
function buildHelpEmbed() {
    return new EmbedBuilder()
        .setTitle("📖 Arbix Bot — Command Guide")
        .setDescription(
            `**Prefix:** \`${PREFIX}\` — use these in any channel or DM\n\n` +
            `**🔐 Verification**\n` +
            `\`${PREFIX}verify [arbixUserId]\`  — start verification\n` +
            `\`/verify userid:<id>\`  — slash version\n\n` +
            `**🖼️ Avatar**\n` +
            `\`${PREFIX}avatar\`  — attach an image to your message\n` +
            `\`${PREFIX}avatar <imageURL>\`  — or paste a direct image link\n` +
            `\`/avatar url:<link>\`  — slash version\n\n` +
            `**ℹ️ Info**\n` +
            `\`${PREFIX}help\`  — this panel\n` +
            `\`${PREFIX}whoami\`  — show your linked account\n` +
            `\`${PREFIX}unverify\`  — unlink your Discord\n\n` +
            `**💡 Tips**\n` +
            `• Avatars accept **PNG / JPG / GIF / WebP**\n` +
            `• Verifications expire after **10 minutes**\n` +
            `• The bot must share a server with you to DM you`
        )
        .setColor(0x5865F2)
        .setFooter({ text: "Arbix Hub — Bot Guide" })
        .setTimestamp();
}

// ─── Post-verification embed (teaches avatar setup) ───
function buildPostVerifyEmbed(discordId, arbixUserId) {
    const alreadySet = userAvatars.has(arbixUserId);
    return new EmbedBuilder()
        .setTitle("✅ Verified Successfully")
        .setDescription(
            `Your Discord is now linked to Arbix account **\`${arbixUserId}\`**.\n\n` +
            `**🎨 Set your chat avatar**\n` +
            `Open ArbixOS → Chat and your avatar will appear next to your messages.\n\n` +
            `**Option 1 — Upload an image**\n` +
            `Type \`${PREFIX}avatar\` with an image **attached**, or just type \`${PREFIX}avatar\` ` +
            `and I'll reply asking you to send the image.\n\n` +
            `**Option 2 — Use an image URL**\n` +
            `Type \`${PREFIX}avatar https://example.com/image.png\`\n\n` +
            `**🎮 Prefix commands**\n` +
            `\`${PREFIX}help\` — see every command\n` +
            `\`${PREFIX}whoami\` — show your linked account\n` +
            `\`${PREFIX}unverify\` — unlink your Discord\n\n` +
            (alreadySet
                ? `**Your current avatar is already set.** Run \`${PREFIX}avatar\` again to replace it.`
                : `**You don't have an avatar set yet.** Run \`${PREFIX}avatar\` to add one.`
            )
        )
        .setColor(0x57F287)
        .setFooter({ text: "Arbix Hub — Verified" })
        .setTimestamp();
}

// ─── Send verification DM ───
async function openVerificationDM(discordId, arbixUserId) {
    const user = await client.users.fetch(discordId);
    const code = generateCode();

    pendingVerifications.set(discordId, {
        arbixUserId,
        code,
        expiresAt: Date.now() + 10 * 60 * 1000,
    });

    // Auto-expire after 10 minutes
    setTimeout(() => {
        const p = pendingVerifications.get(discordId);
        if (p && p.code === code) pendingVerifications.delete(discordId);
    }, 10 * 60 * 1000);

    const verifyEmbed = new EmbedBuilder()
        .setTitle("🎮 Arbix Verification Request")
        .setDescription(
            `An account is trying to link to your Discord.\n\n` +
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
            "**3. Chat in-game** — open ArbixOS → Chat, your avatar appears next to your messages\n\n" +
            "Type `!help` anytime to see all commands."
        )
        .setColor(0x57F287);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`verify_yes:${arbixUserId}`)
            .setLabel("Verify")
            .setStyle(ButtonStyle.Success)
            .setEmoji("✅"),
        new ButtonBuilder()
            .setCustomId(`verify_no:${arbixUserId}`)
            .setLabel("It's Not Me")
            .setStyle(ButtonStyle.Danger)
            .setEmoji("❌")
    );

    await user.send({ embeds: [verifyEmbed, helpEmbed], components: [row] });
}

function generateCode() {
    const chars = "ABCDEFGHIJKLMNPQRSTUVWXYZ23456789";
    let out = "";
    for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
}

// ─── Find arbixUserId from a Discord user ID ───
function findArbixByDiscord(discordId) {
    for (const [arbixId, data] of verifiedUsers.entries()) {
        if (data.discordId === discordId) return arbixId;
    }
    return null;
}

// ─── Slash command handler ───
client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand()) {
        // ─── /verify ───
        if (interaction.commandName === "verify") {
            const userId = interaction.options.getString("userid");
            await interaction.deferReply({ ephemeral: true });
            try {
                await openVerificationDM(interaction.user.id, userId);
                await interaction.editReply({ content: "✅ Check your DMs — I sent you a verification prompt." });
            } catch (e) {
                console.error(e);
                await interaction.editReply({ content: "✕ Could not DM you. Make sure you share a server with me." });
            }
            return;
        }

        // ─── /avatar ───
        if (interaction.commandName === "avatar") {
            const url = interaction.options.getString("url");
            const arbixId = findArbixByDiscord(interaction.user.id);
            if (!arbixId) {
                return interaction.reply({
                    content: `✕ You need to verify first. Run \`${PREFIX}verify <arbixUserId>\`.`,
                    ephemeral: true,
                });
            }
            if (!url) {
                // No URL provided → prompt user to attach an image via prefix command
                pendingAvatarUploads.set(interaction.user.id, true);
                return interaction.reply({
                    content: `🖼️ **Send the image here.**\n\nJust upload it in this DM or type \`${PREFIX}avatar\` with an image attached.`,
                    ephemeral: true,
                });
            }
            if (!/^https?:\/\/.+\.(png|jpe?g|gif|webp)(\?.*)?$/i.test(url) && !/^https?:\/\//.test(url)) {
                return interaction.reply({ content: "✕ Invalid image URL.", ephemeral: true });
            }
            userAvatars.set(arbixId, url);
            await interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle("🖼️ Avatar Set")
                        .setDescription(`Your new chat avatar is now active for **\`${arbixId}\`**.`)
                        .setThumbnail(url)
                        .setColor(0x57F287)
                ],
                ephemeral: true,
            });
            return;
        }

        // ─── /help ───
        if (interaction.commandName === "help") {
            await interaction.reply({ embeds: [buildHelpEmbed()], ephemeral: true });
            return;
        }

        // ─── /whoami ───
        if (interaction.commandName === "whoami") {
            const arbixId = findArbixByDiscord(interaction.user.id);
            if (!arbixId) {
                return interaction.reply({
                    content: `You are not verified. Run \`${PREFIX}verify <arbixUserId>\`.`,
                    ephemeral: true,
                });
            }
            const data = verifiedUsers.get(arbixId);
            const avatar = userAvatars.get(arbixId);
            await interaction.reply({
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
            return;
        }
    }

    // ─── Button handler ───
    if (interaction.isButton()) {
        const [action, arbixUserId] = interaction.customId.split(":");
        const pending = pendingVerifications.get(interaction.user.id);

        if (!pending || pending.arbixUserId !== arbixUserId) {
            return interaction.reply({
                content: "✕ This verification has expired or is invalid.",
                ephemeral: true,
            });
        }

        // ─── VERIFY ───
        if (action === "verify_yes") {
            verifiedUsers.set(arbixUserId, {
                discordId: interaction.user.id,
                discordTag: interaction.user.tag,
                verifiedAt: Date.now(),
            });
            pendingVerifications.delete(interaction.user.id);

            // Send the "how to set avatar" embed
            await interaction.update({
                embeds: [buildPostVerifyEmbed(interaction.user.id, arbixUserId)],
                components: [],
            });

            // Log to webhook
            if (WEBHOOK_URL) {
                fetch(WEBHOOK_URL, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        embeds: [{
                            title: "✅ User Verified",
                            color: 0x57F287,
                            fields: [
                                { name: "Arbix ID", value: `\`${arbixUserId}\``, inline: true },
                                { name: "Discord", value: `<@${interaction.user.id}>`, inline: false },
                                { name: "Time", value: `\`${new Date().toISOString()}\``, inline: true },
                            ],
                        }],
                    }),
                }).catch(() => {});
            }
            return;
        }

        // ─── NOT ME ───
        if (action === "verify_no") {
            pendingVerifications.delete(interaction.user.id);
            await interaction.update({
                embeds: [
                    new EmbedBuilder()
                        .setTitle("❌ Verification Declined")
                        .setDescription(
                            `No changes were made. If this was a mistake, run \`${PREFIX}verify <arbixUserId>\` to try again.`
                        )
                        .setColor(0xED4245)
                ],
                components: [],
            });

            if (WEBHOOK_URL) {
                fetch(WEBHOOK_URL, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        embeds: [{
                            title: "❌ Verification Declined",
                            color: 0xED4245,
                            fields: [
                                { name: "Arbix ID", value: `\`${arbixUserId}\``, inline: true },
                                { name: "Discord", value: `<@${interaction.user.id}>`, inline: false },
                            ],
                        }],
                    }),
                }).catch(() => {});
            }
            return;
        }
    }
});

// ─── Prefix command handler (!) ───
client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;

    // ── Handle pending avatar uploads (user was asked to send an image) ──
    const wasWaitingForAvatar = pendingAvatarUploads.get(message.author.id);
    const hasImage = message.attachments.some(a => /\.(png|jpe?g|gif|webp)$/i.test(a.name || "") || (a.contentType || "").startsWith("image/"));

    if (wasWaitingForAvatar && hasImage && !message.content.startsWith(PREFIX)) {
        pendingAvatarUploads.delete(message.author.id);
        const arbixId = findArbixByDiscord(message.author.id);
        if (!arbixId) {
            return message.reply(`✕ You need to verify first. Run \`${PREFIX}verify <arbixUserId>\`.`);
        }
        const attachment = message.attachments.find(a => (a.contentType || "").startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(a.name || ""));
        if (!attachment) return message.reply("✕ No valid image found.");
        userAvatars.set(arbixId, attachment.url);
        return message.reply({
            embeds: [
                new EmbedBuilder()
                    .setTitle("🖼️ Avatar Updated")
                    .setDescription(`Your new avatar is now active for **\`${arbixId}\`.`)
                    .setThumbnail(attachment.url)
                    .setColor(0x57F287)
                    .setTimestamp()
            ]
        });
    }

    // ── Normal prefix commands ──
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const cmd = (args.shift() || "").toLowerCase();
    const rest = args.join(" ");

    // ── !help ──
    if (cmd === "help") {
        return message.reply({ embeds: [buildHelpEmbed()] });
    }

    // ── !verify ──
    if (cmd === "verify") {
        if (!rest) {
            return message.reply(`Usage: \`${PREFIX}verify <arbixUserId>\``);
        }
        try {
            await openVerificationDM(message.author.id, rest);
            return message.reply("✅ Check your DMs — I sent you a verification prompt.");
        } catch (e) {
            console.error(e);
            return message.reply("✕ Could not DM you. Make sure you share a server with me.");
        }
    }

    // ── !avatar ──
    if (cmd === "avatar") {
        const arbixId = findArbixByDiscord(message.author.id);
        if (!arbixId) {
            return message.reply(`✕ You need to verify first. Run \`${PREFIX}verify <arbixUserId>\`.`);
        }

        // 1. User passed a URL
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

        // 2. User attached an image to this message
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
                        .setDescription(`Your new avatar is now active for **\`${arbixId}\`**.`)
                        .setThumbnail(attachment.url)
                        .setColor(0x57F287)
                        .setTimestamp()
                ]
            });
        }

        // 3. No URL, no attachment — ask them to send the image
        pendingAvatarUploads.set(message.author.id, true);
        return message.reply({
            embeds: [
                new EmbedBuilder()
                    .setTitle("🖼️ Send Your Avatar")
                    .setDescription(
                        `**Send the image here** — just upload it as an attachment in your next message.\n\n` +
                        `Or paste a direct image URL:\n\`${PREFIX}avatar https://example.com/image.png\`\n\n` +
                        `*Supported formats: PNG · JPG · GIF · WebP*`
                    )
                    .setColor(0x5865F2)
            ]
        });
    }

    // ── !whoami ──
    if (cmd === "whoami") {
        const arbixId = findArbixByDiscord(message.author.id);
        if (!arbixId) {
            return message.reply(`You are not verified. Run \`${PREFIX}verify <arbixUserId>\`.`);
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
                        { name: "Avatar", value: avatar ? `[Link](${avatar})` : "*not set — run `" + PREFIX + "avatar`*", inline: false }
                    )
                    .setColor(0x5869F2)
                    .setThumbnail(avatar || null)
            ]
        });
    }

    // ── !unverify ──
    if (cmd === "unverify") {
        const arbixId = findArbixByDiscord(message.author.id);
        if (!arbixId) {
            return message.reply("You are not verified.");
        }
        verifiedUsers.delete(arbixId);
        userAvatars.delete(arbixId);
        return message.reply({
            embeds: [
                new EmbedBuilder()
                    .setTitle("🔓 Unverified")
                    .setDescription(`Your Discord has been unlinked from \`${arbixId}\`. Run \`${PREFIX}verify <arbixUserId>\` to link again.`)
                    .setColor(0xED4245)
                    .setTimestamp()
            ]
        });
    }
});

// ─── HTTP API for the Roblox script ───
const app = express();
app.use(express.json());

app.post("/verify/request", async (req, res) => {
    const { discordId, arbixUsername, arbixUserId } = req.body || {};
    if (!discordId) return res.status(400).json({ error: "discordId required" });
    try {
        await openVerificationDM(discordId, arbixUserId || "unknown");
        const pending = pendingVerifications.get(discordId);
        res.json({ ok: true, code: pending ? pending.code : null });
    } catch (e) {
        console.error("verify/request error:", e);
        res.status(500).json({ error: "could not send DM" });
    }
});

app.post("/verify/status", (req, res) => {
    const { arbixUserId } = req.body || {};
    if (!arbixUserId) return res.status(400).json({ error: "arbixUserId required" });
    const v = verifiedUsers.get(arbixUserId);
    if (v) {
        res.json({ verified: true, discordId: v.discordId, discordTag: v.discordTag });
    } else {
        res.json({ verified: false });
    }
});

app.post("/avatar/get", (req, res) => {
    const { arbixUserId } = req.body || {};
    res.json({ avatar: userAvatars.get(arbixUserId) || null });
});

app.listen(PORT, () => console.log(`[Bot] HTTP API running on port ${PORT}`));

client.login(BOT_TOKEN);
