// Arbix Discord Verification Bot
// Deploy to Railway / Replit / any Node host that runs 24/7
//
// Required env vars:
//   DISCORD_BOT_TOKEN  = your bot token
//   WEBHOOK_URL        = your webhook (for logging verifies)
//   PORT               = 3000 (default)
//
// Also needs a static URL for users to see help: HELP_PANEL_URL
//
// Commands it handles:
//   /verify   — opens help panel + starts DM verification
//   /avatar   — set your chat avatar (image URL)
//   /help     — show the setup help panel

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
        ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
        ActivityType, Events, ChannelType } = require("discord.js");
const express = require("express");
const http = require("http");

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const HELP_PANEL_URL = process.env.HELP_PANEL_URL || "https://arbix-hub.example.com/help";
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
    console.error("Missing DISCORD_BOT_TOKEN");
    process.exit(1);
}

// ─── In-memory stores (swap for Firebase in production) ───
const pendingVerifications = new Map();   // discordId -> { arbixUsername, arbixUserId, code, createdAt }
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
    partials: ["CHANNEL", "MESSAGE"],
});

client.once(Events.ClientReady, async (c) => {
    console.log(`[Bot] Logged in as ${c.user.tag}`);
    c.user.setPresence({
        activities: [{ name: "Arbix Hub", type: ActivityType.Watching }],
        status: "online",  // stays online 24/7 as long as the process runs
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
            .setDescription("Set your Arbix chat avatar (image URL)")
            .addStringOption(o => o.setName("url").setDescription("Direct image URL").setRequired(true))
            .toJSON(),
        new SlashCommandBuilder()
            .setName("help")
            .setDescription("How to set up and use the Arbix bot")
            .toJSON(),
    ];

    const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);
    try {
        await rest.put(Routes.applicationGuildCommands(c.user.id, "1535648815648870410"), { body: commands });
        console.log("[Bot] Slash commands registered");
    } catch (e) {
        console.error("Register error:", e);
    }
});

// ─── Slash command handler ───
client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand()) {
        if (interaction.commandName === "verify") {
            const userId = interaction.options.getString("userid");
            await interaction.deferReply({ ephemeral: true });
            try {
                await openVerificationDM(interaction.user.id, userId);
                await interaction.editReply({
                    content: "✅ Check your DMs — I sent you a verification prompt.",
                });
            } catch (e) {
                await interaction.editReply({
                    content: "✕ Could not DM you. Make sure you share a server with me.",
                });
            }
            return;
        }

        if (interaction.commandName === "avatar") {
            const url = interaction.options.getString("url");
            if (!/^https?:\/\//.test(url)) {
                return interaction.reply({ content: "✕ Invalid URL.", ephemeral: true });
            }
            userAvatars.set(interaction.user.id, url);
            await interaction.reply({
                content: `✅ Avatar set! Your chat messages will now show this image.`,
                ephemeral: true,
            });
            return;
        }

        if (interaction.commandName === "help") {
            const embed = new EmbedBuilder()
                .setTitle("Arbix Bot — Help Panel")
                .setDescription(
                    "**Setup**\n" +
                    "1. Run `/verify userid:<your Arbix user ID>`\n" +
                    "2. Check your DMs — you'll see a Verify / Not Me prompt\n" +
                    "3. Click **Verify** to link your Discord to your Arbix account\n" +
                    "4. Click **It's Not Me** to decline\n\n" +
                    "**Commands**\n" +
                    "`/verify` — start verification\n" +
                    "`/avatar url:<image URL>` — set your chat avatar\n" +
                    "`/help` — show this panel\n\n" +
                    "**Notes**\n" +
                    "• The bot must be in a mutual server with you to DM you\n" +
                    "• Avatars are cached for the session\n" +
                    "• Verifications expire after 10 minutes"
                )
                .setColor(0x5865F2)
                .setFooter({ text: "Arbix Hub — Verification" });
            await interaction.reply({ embeds: [embed], ephemeral: true });
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

        if (action === "verify_yes") {
            verifiedUsers.set(arbixUserId, {
                discordId: interaction.user.id,
                discordTag: interaction.user.tag,
                verifiedAt: Date.now(),
            });
            pendingVerifications.delete(interaction.user.id);

            await interaction.update({
                content: `✅ **Verified!** Your Arbix account is now linked to <@${interaction.user.id}>.`,
                embeds: [],
                components: [],
            });

            if (WEBHOOK_URL) {
                fetch(WEBHOOK_URL, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        embeds: [{
                            title: "✅ User Verified",
                            color: 0x57F287,
                            fields: [
                                { name: "Arbix User", value: `\`${pending.arbixUsername}\``, inline: true },
                                { name: "Arbix ID", value: `\`${pending.arbixUserId}\``, inline: true },
                                { name: "Discord", value: `<@${interaction.user.id}>`, inline: false },
                                { name: "Time", value: `\`${new Date().toISOString()}\``, inline: true },
                            ],
                        }],
                    }),
                }).catch(() => {});
            }
            return;
        }

        if (action === "verify_no") {
            pendingVerifications.delete(interaction.user.id);
            await interaction.update({
                content: "❌ Verification declined. You can run `/verify` again anytime.",
                embeds: [],
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
                                { name: "Arbix User", value: `\`${pending.arbixUsername}\``, inline: true },
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

// ─── Send the verification DM with help panel ───
async function openVerificationDM(discordId, arbixUserId) {
    const user = await client.users.fetch(discordId);
    const code = generateCode();

    pendingVerifications.set(discordId, {
        arbixUsername: arbixUserId,
        arbixUserId,
        code,
        createdAt: Date.now(),
    });

    // Auto-expire after 10 minutes
    setTimeout(() => pendingVerifications.delete(discordId), 10 * 60 * 1000);

    const embed = new EmbedBuilder()
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
        .setTitle("📖 How to use the Arbix Bot")
        .setDescription(
            "**Step 1 — Verify**\n" +
            "Click **Verify** below. This links your Discord to your Arbix account.\n\n" +
            "**Step 2 — Set your avatar (optional)**\n" +
            "Run `/avatar url:<image URL>` in any channel I can see.\n" +
            "Your chat messages will now include this avatar.\n\n" +
            "**Step 3 — Chat in-game**\n" +
            "Open ArbixOS → Chat. Your Discord avatar and tag appear next to your messages.\n\n" +
            "**Need more info?** Run `/help` anytime."
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

    await user.send({ embeds: [embed, helpEmbed], components: [row] });
}

function generateCode() {
    const chars = "ABCDEFGHIJKLMNPQRSTUVWXYZ23456789";
    let out = "";
    for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
}

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

app.listen(PORT, () => console.log(`[Bot] HTTP API on :${PORT}`));

client.login(BOT_TOKEN);
