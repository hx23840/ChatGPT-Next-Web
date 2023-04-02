import { create } from "zustand";
import { persist } from "zustand/middleware";

import { type ChatCompletionResponseMessage } from "openai";
import {
  ControllerPool,
  getKnowledge,
  requestChat,
  requestChatStream,
  requestWithPrompt,
} from "../requests";
import { trimTopic } from "../utils";

import Locale from "../locales";
import { it } from "node:test";
import locales from "../locales";

export type Message = ChatCompletionResponseMessage & {
  date: string;
  streaming?: boolean;
  isVisible: boolean;
};

export enum SubmitKey {
  Enter = "Enter",
  CtrlEnter = "Ctrl + Enter",
  ShiftEnter = "Shift + Enter",
  AltEnter = "Alt + Enter",
  MetaEnter = "Meta + Enter",
}

export enum Theme {
  Auto = "auto",
  Dark = "dark",
  Light = "light",
}

export interface ChatConfig {
  historyMessageCount: number; // -1 means all
  compressMessageLengthThreshold: number;
  sendBotMessages: boolean; // send bot's message or not
  submitKey: SubmitKey;
  avatar: string;
  fontSize: number;
  theme: Theme;
  tightBorder: boolean;

  disablePromptHint: boolean;

  modelConfig: {
    model: string;
    temperature: number;
    max_tokens: number;
    presence_penalty: number;
  };
}

export type ModelConfig = ChatConfig["modelConfig"];

const ENABLE_GPT4 = true;

export const ALL_MODELS = [
  {
    name: "gpt-4",
    available: ENABLE_GPT4,
  },
  {
    name: "gpt-4-0314",
    available: ENABLE_GPT4,
  },
  {
    name: "gpt-4-32k",
    available: ENABLE_GPT4,
  },
  {
    name: "gpt-4-32k-0314",
    available: ENABLE_GPT4,
  },
  {
    name: "gpt-3.5-turbo",
    available: true,
  },
  {
    name: "gpt-3.5-turbo-0301",
    available: true,
  },
];

export function isValidModel(name: string) {
  return ALL_MODELS.some((m) => m.name === name && m.available);
}

export function isValidNumber(x: number, min: number, max: number) {
  return typeof x === "number" && x <= max && x >= min;
}

export function filterConfig(oldConfig: ModelConfig): Partial<ModelConfig> {
  const config = Object.assign({}, oldConfig);

  const validator: {
    [k in keyof ModelConfig]: (x: ModelConfig[keyof ModelConfig]) => boolean;
  } = {
    model(x) {
      return isValidModel(x as string);
    },
    max_tokens(x) {
      return isValidNumber(x as number, 100, 4000);
    },
    presence_penalty(x) {
      return isValidNumber(x as number, -2, 2);
    },
    temperature(x) {
      return isValidNumber(x as number, 0, 2);
    },
  };

  Object.keys(validator).forEach((k) => {
    const key = k as keyof ModelConfig;
    if (!validator[key](config[key])) {
      delete config[key];
    }
  });

  return config;
}

const DEFAULT_CONFIG: ChatConfig = {
  historyMessageCount: 4,
  compressMessageLengthThreshold: 1000,
  sendBotMessages: true as boolean,
  submitKey: SubmitKey.CtrlEnter as SubmitKey,
  avatar: "1f412",
  fontSize: 14,
  theme: Theme.Auto as Theme,
  tightBorder: false,

  disablePromptHint: false,

  modelConfig: {
    model: "gpt-3.5-turbo",
    temperature: 1,
    max_tokens: 3000,
    presence_penalty: 0,
  },
};

export interface ChatStat {
  tokenCount: number;
  wordCount: number;
  charCount: number;
}

export interface ChatSession {
  id: number;
  topic: string;
  memoryPrompt: string;
  messages: Message[];
  stat: ChatStat;
  lastUpdate: string;
  lastSummarizeIndex: number;
  bot_name: string;
}

const DEFAULT_TOPIC = Locale.Store.DefaultTopic;

function createEmptySession(): ChatSession {
  const createDate = new Date().toLocaleString();

  return {
    id: Date.now(),
    topic: DEFAULT_TOPIC,
    memoryPrompt: "",
    messages: [
      {
        role: "assistant",
        content: Locale.Store.BotHello,
        date: createDate,
        isVisible: true,
      },
    ],
    stat: {
      tokenCount: 0,
      wordCount: 0,
      charCount: 0,
    },
    lastUpdate: createDate,
    lastSummarizeIndex: 0,

    bot_name: "",
  };
}

interface ChatStore {
  config: ChatConfig;
  sessions: ChatSession[];
  currentSessionIndex: number;
  removeSession: (index: number) => void;
  selectSession: (index: number) => void;
  newSession: (bot_name: string) => void;
  currentSession: () => ChatSession;
  onNewMessage: (message: Message) => void;
  onUserInput: (content: string) => Promise<void>;
  summarizeSession: () => void;
  updateStat: (message: Message) => void;
  updateCurrentSession: (updater: (session: ChatSession) => void) => void;
  updateMessage: (
    sessionIndex: number,
    messageIndex: number,
    updater: (message?: Message) => void,
  ) => void;
  getMessagesWithMemory: () => Message[];
  getMemoryPrompt: () => Message;

  getConfig: () => ChatConfig;
  resetConfig: () => void;
  updateConfig: (updater: (config: ChatConfig) => void) => void;
  clearAllData: () => void;
}

function countMessages(msgs: Message[]) {
  return msgs.reduce((pre, cur) => pre + cur.content.length, 0);
}

function countTokens(text: string): number {
  const tokenPattern = /([\p{L}\p{N}]+)|\s+|(.)\p{Zs}*/gu;
  const tokens = Array.from(text.matchAll(tokenPattern));
  return tokens.length;
}

// 检查knowledgeMessage是否在recentMessages中的函数
function isMessageInRecentMessages(
  recentMessages: Message[],
  pageContent: string,
): boolean {
  return recentMessages.some((item) => item.content.includes(pageContent));
}

const LOCAL_KEY = "chat-next-web-store";

export const useChatStore = create<ChatStore>()(
  persist(
    (set, get) => ({
      sessions: [createEmptySession()],
      currentSessionIndex: 0,
      config: {
        ...DEFAULT_CONFIG,
      },

      resetConfig() {
        set(() => ({ config: { ...DEFAULT_CONFIG } }));
      },

      getConfig() {
        return get().config;
      },

      updateConfig(updater) {
        const config = get().config;
        updater(config);
        set(() => ({ config }));
      },

      selectSession(index: number) {
        set({
          currentSessionIndex: index,
        });
      },

      removeSession(index: number) {
        set((state) => {
          let nextIndex = state.currentSessionIndex;
          const sessions = state.sessions;

          if (sessions.length === 1) {
            return {
              currentSessionIndex: 0,
              sessions: [createEmptySession()],
            };
          }

          sessions.splice(index, 1);

          if (nextIndex === index) {
            nextIndex -= 1;
          }

          return {
            currentSessionIndex: nextIndex,
            sessions,
          };
        });
      },

      newSession(bot_name: string) {
        let empty_session: ChatSession = createEmptySession();
        empty_session.bot_name = bot_name;

        set((state) => ({
          currentSessionIndex: 0,
          sessions: [empty_session].concat(state.sessions),
        }));

        if (get().currentSession().bot_name.startsWith("caozbot")) {
          empty_session.messages = [];
          empty_session.topic = locales.Home.NewCaozChat;
          const helloMessage: Message = {
            role: "assistant",
            content:
              "你好，我收集了2015年至2023年3月23日之间的微信公众号文章合计1027篇，你可以咨询相关问题！",
            date: new Date().toLocaleString(),
            isVisible: true,
          };

          get().updateCurrentSession((session) => {
            session.messages.push(helloMessage);
          });
        }
      },

      currentSession() {
        let index = get().currentSessionIndex;
        const sessions = get().sessions;

        if (index < 0 || index >= sessions.length) {
          index = Math.min(sessions.length - 1, Math.max(0, index));
          set(() => ({ currentSessionIndex: index }));
        }

        return sessions[index];
      },

      onNewMessage(message) {
        get().updateCurrentSession((session) => {
          session.lastUpdate = new Date().toLocaleString();
        });
        get().updateStat(message);
        get().summarizeSession();
      },

      async onUserInput(content) {
        // get recent messages
        let recentMessages = get().getMessagesWithMemory();
        let sendMessages: Message[] = [];

        if (get().currentSession().bot_name.startsWith("caozbot")) {
          let jsonString = await getKnowledge(content);
          const parsedDocuments = JSON.parse(jsonString);

          await Promise.all(
            parsedDocuments.map(async (doc: any) => {
              if (!isMessageInRecentMessages(recentMessages, doc.pageContent)) {
                const knowledgeMessage: Message = {
                  role: "user",
                  content: doc.pageContent,
                  date: new Date().toLocaleString(),
                  isVisible: false,
                };

                const tokenCount = countTokens(doc.pageContent);

                if (tokenCount > 100) {
                  let messages = [knowledgeMessage].concat({
                    role: "user",
                    content:
                      "Write a concise summary of the following and CONCISE SUMMARY, Please answer use Chinese",
                    date: "",
                    isVisible: false,
                  });
                  const res = await requestChat(messages);
                  if (res) {
                    const knowledgeMessage: Message = {
                      role: "user",
                      content: res?.choices?.[0]?.message?.content as string,
                      date: new Date().toLocaleString(),
                      isVisible: false,
                    };
                    sendMessages = sendMessages.concat(knowledgeMessage);
                  }
                } else {
                  sendMessages = sendMessages.concat(knowledgeMessage);
                }

                get().updateCurrentSession((session) => {
                  session.messages.push(knowledgeMessage);
                });
              }
            }),
          );
        }

        const userMessage: Message = {
          role: "user",
          content,
          date: new Date().toLocaleString(),
          isVisible: true,
        };

        const botMessage: Message = {
          content: "",
          role: "assistant",
          date: new Date().toLocaleString(),
          streaming: true,
          isVisible: true,
        };

        const sysMessage: Message = {
          role: "system",
          content: Locale.Store.Prompt.Caoz,
          date: new Date().toLocaleString(),
          isVisible: false,
        };

        sendMessages = recentMessages
          .concat(sendMessages)
          .concat(userMessage)
          .concat(sysMessage);
        const sessionIndex = get().currentSessionIndex;
        const messageIndex = get().currentSession().messages.length + 1;

        // save user's and bot's message
        get().updateCurrentSession((session) => {
          session.messages.push(userMessage);
          session.messages.push(botMessage);
        });

        // make request
        console.log("[User Input] ", sendMessages);
        requestChatStream(sendMessages, {
          onMessage(content, done) {
            // stream response
            if (done) {
              botMessage.streaming = false;
              botMessage.content = content;
              get().onNewMessage(botMessage);
              ControllerPool.remove(sessionIndex, messageIndex);
            } else {
              botMessage.content = content;
              set(() => ({}));
            }
          },
          onError(error) {
            botMessage.content += "\n\n" + Locale.Store.Error;
            botMessage.streaming = false;
            set(() => ({}));
            ControllerPool.remove(sessionIndex, messageIndex);
          },
          onController(controller) {
            // collect controller for stop/retry
            ControllerPool.addController(
              sessionIndex,
              messageIndex,
              controller,
            );
          },
          filterBot: !get().config.sendBotMessages,
          modelConfig: get().config.modelConfig,
        });
      },

      getMemoryPrompt() {
        const session = get().currentSession();

        return {
          role: "system",
          content: Locale.Store.Prompt.History(session.memoryPrompt),
          date: "",
        } as Message;
      },

      getMessagesWithMemory() {
        const session = get().currentSession();
        const config = get().config;
        const n = session.messages.length;
        const recentMessages = session.messages.slice(
          n - config.historyMessageCount,
        );

        const memoryPrompt = get().getMemoryPrompt();

        if (session.memoryPrompt) {
          recentMessages.unshift(memoryPrompt);
        }

        return recentMessages;
      },

      updateMessage(
        sessionIndex: number,
        messageIndex: number,
        updater: (message?: Message) => void,
      ) {
        const sessions = get().sessions;
        const session = sessions.at(sessionIndex);
        const messages = session?.messages;
        updater(messages?.at(messageIndex));

        set(() => ({ sessions }));
      },

      summarizeSession() {
        const session = get().currentSession();

        // should summarize topic after chating more than 50 words
        const SUMMARIZE_MIN_LEN = 50;
        if (
          session.topic === DEFAULT_TOPIC &&
          countMessages(session.messages) >= SUMMARIZE_MIN_LEN
        ) {
          requestWithPrompt(session.messages, Locale.Store.Prompt.Topic).then(
            (res) => {
              get().updateCurrentSession(
                (session) => (session.topic = trimTopic(res)),
              );
            },
          );
        }

        const config = get().config;
        let toBeSummarizedMsgs = session.messages.slice(
          session.lastSummarizeIndex,
        );
        const historyMsgLength = countMessages(toBeSummarizedMsgs);

        if (historyMsgLength > 4000) {
          toBeSummarizedMsgs = toBeSummarizedMsgs.slice(
            -config.historyMessageCount,
          );
        }

        // add memory prompt
        toBeSummarizedMsgs.unshift(get().getMemoryPrompt());

        const lastSummarizeIndex = session.messages.length;

        console.log(
          "[Chat History] ",
          toBeSummarizedMsgs,
          historyMsgLength,
          config.compressMessageLengthThreshold,
        );

        if (historyMsgLength > config.compressMessageLengthThreshold) {
          requestChatStream(
            toBeSummarizedMsgs.concat({
              role: "system",
              content: Locale.Store.Prompt.Summarize,
              date: "",
              isVisible: false,
            }),
            {
              filterBot: false,
              onMessage(message, done) {
                session.memoryPrompt = message;
                if (done) {
                  console.log("[Memory] ", session.memoryPrompt);
                  session.lastSummarizeIndex = lastSummarizeIndex;
                }
              },
              onError(error) {
                console.error("[Summarize] ", error);
              },
            },
          );
        }
      },

      updateStat(message) {
        get().updateCurrentSession((session) => {
          session.stat.charCount += message.content.length;
          // TODO: should update chat count and word count
        });
      },

      updateCurrentSession(updater) {
        const sessions = get().sessions;
        const index = get().currentSessionIndex;
        updater(sessions[index]);
        set(() => ({ sessions }));
      },

      clearAllData() {
        if (confirm(Locale.Store.ConfirmClearAll)) {
          localStorage.clear();
          location.reload();
        }
      },
    }),
    {
      name: LOCAL_KEY,
      version: 1,
    },
  ),
);
