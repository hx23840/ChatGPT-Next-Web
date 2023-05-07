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
import { isMobileScreen, trimTopic } from "../utils";

import Locale from "../locales";
import { showToast } from "../components/ui-lib";
import { ModelType, useAppConfig } from "./config";
import { it } from "node:test";
import locales from "../locales";

export type Message = ChatCompletionResponseMessage & {
  date: string;
  streaming?: boolean;
  isError?: boolean;
  isVisible: boolean;
  id?: number;
  model?: ModelType;
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

export const ROLES: Message["role"][] = ["system", "user", "assistant"];

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
  sessions: ChatSession[];
  currentSessionIndex: number;
  clearSessions: () => void;
  removeSession: (index: number) => void;
  moveSession: (from: number, to: number) => void;
  selectSession: (index: number) => void;
  newSession: (bot_name: string) => void;
  deleteSession: (index?: number) => void;
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

      clearSessions() {
        set(() => ({
          sessions: [createEmptySession()],
          currentSessionIndex: 0,
        }));
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

      deleteSession(i?: number) {
        const deletedSession = get().currentSession();
        const index = i ?? get().currentSessionIndex;
        const isLastSession = get().sessions.length === 1;
        if (!isMobileScreen() || confirm(Locale.Home.DeleteChat)) {
          get().removeSession(index);

          showToast(
            Locale.Home.DeleteToast,
            {
              text: Locale.Home.Revert,
              onClick() {
                set((state) => ({
                  sessions: state.sessions
                    .slice(0, index)
                    .concat([deletedSession])
                    .concat(
                      state.sessions.slice(index + Number(isLastSession)),
                    ),
                }));
              },
            },
            5000,
          );
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

        const sessionIndex = get().currentSessionIndex;
        const messageIndex = get().currentSession().messages.length + 1;

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
          id: userMessage.id! + 1,
          model: useAppConfig.getState().modelConfig.model,
        };

        // save user's and bot's message
        get().updateCurrentSession((session) => {
          session.messages.push(userMessage);
        });

        if (get().currentSession().bot_name.startsWith("caozbot")) {
          let response = await getKnowledge(content);
          let res_json = await response.text();

          if (response.status == 500) {
            botMessage.content = res_json;

            get().updateCurrentSession((session) => {
              session.messages.push(botMessage);
            });

            botMessage.streaming = false;
            userMessage.isError = true;
            botMessage.isError = true;
            set(() => ({}));
            ControllerPool.remove(sessionIndex, botMessage.id ?? messageIndex);
            (botMessage.date = new Date().toLocaleString()), set(() => ({}));
            ControllerPool.remove(sessionIndex, messageIndex);

            return;
          }

          const parsedDocuments = JSON.parse(JSON.parse(res_json));

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
              "Please review the reference materials provided within delimited by triple backticks (`) for potential questions that users may ask. For each question, please provide a detailed response that addresses the user's concerns and provides relevant information or recommendations based on your expertise.\n" +
              'For questions that are not related to the following information, ChatGPT should reject them and inform the user that "Your question is not related to the author.' +
              "Please provide a related question. Please answer with Chinese",
            date: new Date().toLocaleString(),
            isVisible: false,
          };

          for (const doc of parsedDocuments) {
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

                  knowledgeMessage.content =
                    "```" + knowledgeMessage.content + "```";

                  sendMessages = sendMessages.concat(knowledgeMessage);
                }
              } else {
                knowledgeMessage.content =
                  "```" + knowledgeMessage.content + "```";
                sendMessages = sendMessages.concat(knowledgeMessage);
              }

              get().updateCurrentSession((session) => {
                knowledgeMessage.content =
                  "微信公众号原文：" + knowledgeMessage.content;
                session.messages.push(knowledgeMessage);
              });
            }
          }

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
        if (
          tokenCount + useAppConfig.getState().modelConfig.max_tokens >
          4000
        ) {
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
            } else if (!error.message.includes("aborted")) {
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
          filterBot: !useAppConfig.getState().sendBotMessages,
          modelConfig: useAppConfig.getState().modelConfig,
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
        const config = useAppConfig.getState();
        const messages = session.messages.filter((msg) => !msg.isError);
        const n = messages.length;

        const context = session.context.slice();

        // long term memory
        if (
          session.sendMemory &&
          session.memoryPrompt &&
          session.memoryPrompt.length > 0
        ) {
          const memoryPrompt = get().getMemoryPrompt();
          context.push(memoryPrompt);
        }

        // get short term and unmemoried long term memory
        const shortTermMemoryMessageIndex = Math.max(
          0,
          n - config.historyMessageCount,
        );
        const longTermMemoryMessageIndex = session.lastSummarizeIndex;
        const oldestIndex = Math.max(
          shortTermMemoryMessageIndex,
          longTermMemoryMessageIndex,
        );
        const threshold = config.compressMessageLengthThreshold;

        // get recent messages as many as possible
        const reversedRecentMessages = [];
        for (
          let i = n - 1, count = 0;
          i >= oldestIndex && count < threshold;
          i -= 1
        ) {
          const msg = messages[i];
          if (!msg || msg.isError) continue;
          count += msg.content.length;
          reversedRecentMessages.push(msg);
        }

        // concat
        const recentMessages = context.concat(reversedRecentMessages.reverse());

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
          requestWithPrompt(session.messages, Locale.Store.Prompt.Topic, {
            model: "gpt-3.5-turbo",
          }).then((res) => {
            get().updateCurrentSession(
              (session) =>
                (session.topic = res ? trimTopic(res) : DEFAULT_TOPIC),
            );
          });
        }

        const config = useAppConfig.getState();
        let toBeSummarizedMsgs = session.messages.slice(
          session.lastSummarizeIndex,
        );

        const historyMsgLength = countMessages(toBeSummarizedMsgs);

        if (historyMsgLength > config?.modelConfig?.max_tokens ?? 4000) {
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

        if (
          historyMsgLength > config.compressMessageLengthThreshold &&
          session.sendMemory
        ) {
          requestChatStream(
            toBeSummarizedMsgs.concat({
              role: "system",
              content: Locale.Store.Prompt.Summarize,
              date: "",
              isVisible: false,
            }),
            {
              filterBot: false,
              model: "gpt-3.5-turbo",
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
