const { Client, GatewayIntentBits } = require("discord.js");
const fs = require("fs");
const bots = JSON.parse(fs.readFileSync("bots.json", "utf-8"));
const usedMessageIds = new Set();
let lastMessageTimeStored = 0;
const { GoogleGenAI } = require("@google/genai");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

function getAndResetStartingBot() {
  const bot = bots.find((b) => b.starting === true);
  if (bot) {
    bot.starting = false;
    fs.writeFileSync("bots.json", JSON.stringify(bots, null, 2), "utf-8");
  }
  return bot || null;
}

const startingBot = getAndResetStartingBot();
const BOTID = startingBot["botId"];
const TARGET_CHANNEL_ID = startingBot["channel"];
const TOKEN = startingBot["token"];
const PROMPT = startingBot["prompt"];
const GEMINI_API_KEY = startingBot["apiKey"];

if (!TOKEN || !BOTID || !TARGET_CHANNEL_ID || !PROMPT || !GEMINI_API_KEY) {
  console.error("Missing environment variables. Please check .env file.");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

function splitMessageData(data) {
  const separatorIndex = data.indexOf(" - ");
  if (separatorIndex === -1) return ["", data]; // No separator found

  const id = data.slice(0, separatorIndex).trim();
  const answer = data.slice(separatorIndex + 3).trim();

  return [id, answer];
}

function cleanUsedMessageIds(usedMessageIds, fetchedMessages) {
  const currentIds = new Set(fetchedMessages.map((msg) => msg.id));

  for (const id of usedMessageIds) {
    if (!currentIds.has(id)) {
      usedMessageIds.delete(id);
    }
  }
}

async function getMostRecentMessageTime(channel) {
  const fetched = await channel.messages.fetch({ limit: 10 });

  const lastNonBotMessage = fetched.find((msg) => !msg.author.bot);

  return lastNonBotMessage?.createdTimestamp || null;
}

async function isNewMessageSince(channel, previousTimestamp) {
  const latestTimestamp = await getMostRecentMessageTime(channel);
  if (latestTimestamp === null) return false; // No user messages to compare

  const isNew = latestTimestamp > previousTimestamp;
  if (isNew) {
    lastMessageTimeStored = latestTimestamp; // Update the stored timestamp
    console.log(lastMessageTimeStored);
  }

  return isNew;
}

function findNewMentionOrReplyMessage(
  messages,
  userId,
  usedMessageIds = new Set()
) {
  return (
    messages.find((msg) => {
      const isNew = !usedMessageIds.has(msg.id);
      const mentionsUser = msg.mentions?.users?.has(userId);
      const isReplyToUser = msg.mentions?.repliedUser?.id === userId;

      return isNew && (mentionsUser || isReplyToUser);
    }) || null
  );
}

async function getConversationContext(fetched, channel) {
  const messagesArray = Array.from(fetched.values());

  // Filtra mensagens com conteúdo
  const unique = messagesArray.filter((msg) => msg.content.trim());

  // Ordena cronologicamente
  const chronological = unique.sort(
    (a, b) => a.createdTimestamp - b.createdTimestamp
  );

  const context = [];

  for (const msg of chronological) {
    let replyText = "";

    if (msg.reference?.messageId) {
      try {
        const repliedMsg = await channel.messages.fetch(
          msg.reference.messageId
        );

        if (repliedMsg && repliedMsg.content.trim()) {
          replyText = `(answering "${repliedMsg.author.username}: ${repliedMsg.content}") `;
        }
      } catch (err) {
        replyText = "(answering []) ";
      }
    }

    context.push(
      `"${msg.author.username}: ${replyText}${msg.content}" - id: ${msg.id}`
    );
  }

  return context;
}

async function getAnswer(prompt) {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      maxOutputTokens: 100,
    });
    const answer = response.candidates[0].content.parts[0].text;
    return answer;
  } catch (error) {
    console.error("Error generating answer:", error);
    return "Sorry, I couldn't answer.";
  }
}

async function promptDesigner(
  messages,
  prompt,
  channel,
  priorityMessage = null
) {
  const conversationContext = await getConversationContext(messages, channel);
  const formattedMessages = conversationContext.join("\n");
  const usedIds = Array.from(usedMessageIds).join(", ");
  const fullPrompt = `${prompt}\n${formattedMessages}\n Remember the character you are when choosing an answer \n/ If there is an id here: ${
    "" + priorityMessage
  }, you might give priority to this message because it calls you directly, but if it is null, or if the context asks for a different message, you choose a message to reply to. Always return the data like this "chosen message id - your answer".\nHere is a list of ids you already replied to, so you don’t pick the same message again: ${usedIds}`;
  const response = await getAnswer(fullPrompt);
  return response;
}

async function fetchMessageById(messageId, channel) {
  try {
    const message = await channel.messages.fetch(messageId);
    return message; // Returns the message object
  } catch (error) {
    console.error(`Could not fetch message with ID ${messageId}:`, error);
    return null; // Return null if not found or error
  }
}

async function sendMessage(replyText, channel, message = null) {
  try {
    if (message) {
      await message.reply(replyText);
    } else {
      await channel.send(replyText);
    }
  } catch (error) {
    console.error("Error replying to message:", error);
  }
}

async function respondAutomatically(channel) {
  try {
    const fetched = await channel.messages.fetch({ limit: 20 });
    cleanUsedMessageIds(usedMessageIds, fetched);
    const priorityMessage = findNewMentionOrReplyMessage(
      fetched,
      BOTID,
      usedMessageIds
    );

    const usedIds = Array.from(usedMessageIds).join(", ");
    const prompt = `${PROMPT}\n you can talk about any subject, respond to most messages with up to 40 words, more than that only if necessary. And here is a list of ids you already replied to, so you don’t pick the same message again: ${usedIds}`;

    if (priorityMessage) {
      const answer = await promptDesigner(
        fetched,
        prompt,
        channel,
        priorityMessage
      );
      const formattedAnswer = splitMessageData(answer);
      const latestTimestamp = await getMostRecentMessageTime(channel);
      lastMessageTimeStored = latestTimestamp;
      usedMessageIds.add(formattedAnswer[0] || ""); // Add the chosen message ID to used IDs
      const replyText =
        formattedAnswer[1] || "Desculpe, não consegui responder.";
      const fetchMessage = await fetchMessageById(formattedAnswer[0], channel);
      await sendMessage(replyText, channel, fetchMessage);
      return;
    }

    if (await isNewMessageSince(channel, lastMessageTimeStored, channel)) {
      const answer = await promptDesigner(fetched, prompt);
      const formattedAnswer = splitMessageData(answer);
      usedMessageIds.add(formattedAnswer[0] || ""); // Add the chosen message ID to used IDs
      const replyText = formattedAnswer[1] || "Sorry, I couldn’t answer.";
      const fetchMessage = await fetchMessageById(formattedAnswer[0], channel);
      await sendMessage(replyText, channel, fetchMessage);
      return;
    }
  } catch (err) {
    console.error("Error while responding automatically:", err);
  }
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const channel = await client.channels.fetch(TARGET_CHANNEL_ID);
  if (!channel || !channel.isTextBased()) {
    console.error("Invalid channel or not a text channel.");
    return;
  }

  // Respond every 5 minutes
  setInterval(() => respondAutomatically(channel), 0.5 * 60 * 1000);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || message.channel.id !== TARGET_CHANNEL_ID) return;

  if (message.content.trim() === "!respond") {
    await respondAutomatically(message.channel);
  }
});

client.login(TOKEN);
