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
  isError?: boolean;
  isVisible: boolean;
  id?: number;
};

export function createMessage(override: Partial<Message>): Message {
  return {
    id: Date.now(),
    date: new Date().toLocaleString(),
    role: "user",
    content: "",
    ...override,
    isVisible: true,
  };
}

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
  sendPreviewBubble: boolean;

  disablePromptHint: boolean;

  modelConfig: {
    model: string;
    temperature: number;
    max_tokens: number;
    presence_penalty: number;
  };
}

export type ModelConfig = ChatConfig["modelConfig"];

export const ROLES: Message["role"][] = ["system", "user", "assistant"];

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

export function limitNumber(
  x: number,
  min: number,
  max: number,
  defaultValue: number,
) {
  if (typeof x !== "number" || isNaN(x)) {
    return defaultValue;
  }

  return Math.min(max, Math.max(min, x));
}

export function limitModel(name: string) {
  return ALL_MODELS.some((m) => m.name === name && m.available)
    ? name
    : ALL_MODELS[4].name;
}

export const ModalConfigValidator = {
  model(x: string) {
    return limitModel(x);
  },
  max_tokens(x: number) {
    return limitNumber(x, 0, 32000, 2000);
  },
  presence_penalty(x: number) {
    return limitNumber(x, -2, 2, 0);
  },
  temperature(x: number) {
    return limitNumber(x, 0, 2, 1);
  },
};

const DEFAULT_CONFIG: ChatConfig = {
  historyMessageCount: 4,
  compressMessageLengthThreshold: 1000,
  sendBotMessages: true as boolean,
  submitKey: SubmitKey.CtrlEnter as SubmitKey,
  avatar: "1f412",
  fontSize: 14,
  theme: Theme.Auto as Theme,
  tightBorder: false,
  sendPreviewBubble: true,

  disablePromptHint: false,

  modelConfig: {
    model: "gpt-3.5-turbo",
    temperature: 1,
    max_tokens: 1000,
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
  sendMemory: boolean;
  memoryPrompt: string;
  context: Message[];
  messages: Message[];
  stat: ChatStat;
  lastUpdate: string;
  lastSummarizeIndex: number;
  bot_name: string;
}

const DEFAULT_TOPIC = Locale.Store.DefaultTopic;
export const BOT_HELLO: Message = createMessage({
  role: "assistant",
  content: Locale.Store.BotHello,
  date: "",
  isVisible: true,
});

function createEmptySession(): ChatSession {
  const createDate = new Date().toLocaleString();

  return {
    id: Date.now(),
    topic: DEFAULT_TOPIC,
    sendMemory: true,
    memoryPrompt: "",
    context: [],
    messages: [],
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
  clearSessions: () => void;
  removeSession: (index: number) => void;
  moveSession: (from: number, to: number) => void;
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
  resetSession: () => void;
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

      clearSessions() {
        set(() => ({
          sessions: [createEmptySession()],
          currentSessionIndex: 0,
        }));
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

      moveSession(from: number, to: number) {
        set((state) => {
          const { sessions, currentSessionIndex: oldIndex } = state;

          // move the session
          const newSessions = [...sessions];
          const session = newSessions[from];
          newSessions.splice(from, 1);
          newSessions.splice(to, 0, session);

          // modify current session id
          let newIndex = oldIndex === from ? to : oldIndex;
          if (oldIndex > from && oldIndex <= to) {
            newIndex -= 1;
          } else if (oldIndex < from && oldIndex >= to) {
            newIndex += 1;
          }

          return {
            currentSessionIndex: newIndex,
            sessions: newSessions,
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

        // save user's and bot's message
        get().updateCurrentSession((session) => {
          session.messages.push(userMessage);
        });

        if (get().currentSession().bot_name.startsWith("caozbot")) {
          let jsonString = await getKnowledge(content);
          const parsedDocuments = JSON.parse(jsonString);

          let sysPromptMessage: Message = {
            role: "system",
            content: Locale.Store.Prompt.Caoz,
            date: new Date().toLocaleString(),
            isVisible: false,
          };

          let assistantPromptMessage: Message = {
            role: "assistant",
            content:
              "请提供一个问题和相关参考内容，以帮助我更好地回答您的问题。",
            date: new Date().toLocaleString(),
            isVisible: false,
          };

          let userPromptMessage: Message = {
            role: "user",
            // content:
            //   "设定下面内容由你提供，请使用第一人称使用以下内容回答所提供的问题。如果该内容不相关，请指出未找到任何信息。" +
            //   "您的任务是阅读并理解给定的内容以回答特定问题。该内容可能包含任何主题的信息，因此在尝试回答问题之前仔细阅读并理解其内容非常重要，" +
            //   "请确保内容原封不动的输出。请注意，如果该内容不包含任何相关信息，则应声明未找到任何信息。",
            content:
              "Please answer the questions and explain in detail strictly based on the following information.\n" +
              "Ignore outlier search results which has nothing to do with the question.\n" +
              "Avoid any references to current or past political figures or events, as well as historical figures or events that may be controversial or divisive.\n" +
              'For questions that are not related to the following information, ChatGPT should reject them and inform the user that "Your question is not related to the author.' +
              "Please provide a related question. Please answer with Chinese",
            date: new Date().toLocaleString(),
            isVisible: false,
          };

          await Promise.all(
            parsedDocuments.map(async (doc: any) => {
              if (!isMessageInRecentMessages(recentMessages, doc.pageContent)) {
                const knowledgeMessage: Message = {
                  role: "assistant",
                  content: doc.pageContent,
                  date: new Date().toLocaleString(),
                  isVisible: true,
                };

                const tokenCount = countMessages([knowledgeMessage]);
                if (tokenCount > 1000) {
                  let summaryMessage: Message = {
                    role: "user",
                    content:
                      "Summarize the following text into 100 words, making it easy to read and comprehend. " +
                      "The summary should be concise, clear, and capture the main points of the text. " +
                      "Avoid using complex sentence structures or technical jargon. " +
                      "Please begin by editing the following text and answer with Chinese.",
                    date: "",
                    isVisible: false,
                  };
                  let messages = [summaryMessage].concat(knowledgeMessage);
                  const res = await requestChat(messages);

                  if (res) {
                    const knowledgeMessage: Message = {
                      role: "assistant",
                      content: res?.choices?.[0]?.message?.content as string,
                      date: new Date().toLocaleString(),
                      isVisible: true,
                    };
                    sendMessages = sendMessages.concat(knowledgeMessage);
                  }
                } else {
                  sendMessages = sendMessages.concat(knowledgeMessage);
                }

                get().updateCurrentSession((session) => {
                  knowledgeMessage.content =
                    "微信公众号原文：" + knowledgeMessage.content;
                  session.messages.push(knowledgeMessage);
                });
              }
            }),
          );

          sendMessages = [sysPromptMessage]
            .concat(recentMessages)
            // .concat([assistantPromptMessage])
            .concat([userPromptMessage])
            .concat(sendMessages)
            .concat(userMessage);
        } else {
          sendMessages = recentMessages
            .concat(sendMessages)
            .concat(userMessage);
        }

        let tokenCount = countMessages(sendMessages);
        if (tokenCount + this.config.modelConfig.max_tokens > 4000) {
          sendMessages = sendMessages.reduce(
            (acc: Message[], message: Message) => {
              if (
                message.role !== "assistant" ||
                countMessages([message]) < 1000
              ) {
                acc.push(message);
              }
              return acc;
            },
            [],
          );
        }

        get().updateCurrentSession((session) => {
          session.messages.push(botMessage);
        });

        botMessage.date = new Date().toLocaleString();

        const sessionIndex = get().currentSessionIndex;
        const messageIndex = get().currentSession().messages.length + 1;

        // make request
        console.log("[User Input Length] ", countMessages(sendMessages));
        console.log("[User Input] ", sendMessages);
        requestChatStream(sendMessages, {
          onMessage(content, done) {
            // stream response
            if (done) {
              botMessage.streaming = false;
              botMessage.content = content;
              get().onNewMessage(botMessage);
              ControllerPool.remove(
                sessionIndex,
                botMessage.id ?? messageIndex,
              );
              (botMessage.date = new Date().toLocaleString()),
                get().onNewMessage(botMessage);
              ControllerPool.remove(sessionIndex, messageIndex);
            } else {
              botMessage.content = content;
              (botMessage.date = new Date().toLocaleString()), set(() => ({}));
            }
          },
          onError(error, statusCode) {
            if (statusCode === 401) {
              botMessage.content = Locale.Error.Unauthorized;
            } else {
              botMessage.content += "\n\n" + Locale.Store.Error;
            }
            botMessage.streaming = false;
            userMessage.isError = true;
            botMessage.isError = true;
            set(() => ({}));
            ControllerPool.remove(sessionIndex, botMessage.id ?? messageIndex);
            (botMessage.date = new Date().toLocaleString()), set(() => ({}));
            ControllerPool.remove(sessionIndex, messageIndex);
          },
          onController(controller) {
            // collect controller for stop/retry
            ControllerPool.addController(
              sessionIndex,
              botMessage.id ?? messageIndex,
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
        const messages = session.messages.filter((msg) => !msg.isError);
        const n = messages.length;

        const context = session.context.slice();

        if (
          session.sendMemory &&
          session.memoryPrompt &&
          session.memoryPrompt.length > 0
        ) {
          const memoryPrompt = get().getMemoryPrompt();
          context.push(memoryPrompt);
        }

        const recentMessages = context.concat(
          messages.slice(Math.max(0, n - config.historyMessageCount)),
        );

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

      resetSession() {
        get().updateCurrentSession((session) => {
          session.messages = [];
          session.memoryPrompt = "";
        });
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
                (session) =>
                  (session.topic = res ? trimTopic(res) : DEFAULT_TOPIC),
              );
            },
          );
        }

        const config = get().config;
        let toBeSummarizedMsgs = session.messages.slice(
          session.lastSummarizeIndex,
        );

        const historyMsgLength = countMessages(toBeSummarizedMsgs);

        if (historyMsgLength > get().config?.modelConfig?.max_tokens ?? 2000) {
          const n = toBeSummarizedMsgs.length;
          toBeSummarizedMsgs = toBeSummarizedMsgs.slice(
            Math.max(0, n - config.historyMessageCount),
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
      version: 1.2,
      migrate(persistedState, version) {
        const state = persistedState as ChatStore;

        if (version === 1) {
          state.sessions.forEach((s) => (s.context = []));
        }

        if (version < 1.2) {
          state.sessions.forEach((s) => (s.sendMemory = true));
        }

        return state;
      },
    },
  ),
);
