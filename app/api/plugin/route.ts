import { ChatGPTPluginRetriever } from "langchain/retrievers";
import { NextRequest } from "next/server";

async function handler(req: NextRequest) {
  const query = req.nextUrl.searchParams.get("query") as string | undefined;
  const bearer = process.env.BEARER as string;

  const apiKey = process.env.OPENAI_API_KEY;

  const retriever = new ChatGPTPluginRetriever({
    url: "https://chatgpt-retrieval-plugin-production-7a30.up.railway.app",
    auth: {
      bearer: bearer,
    },
    topK: 3,
  });

  if (!apiKey) {
    return new Response("No Api Key provided");
  }

  if (query != null) {
    const docs = await retriever.getRelevantDocuments(query);
    return new Response(JSON.stringify(docs));
  } else {
    return new Response("No query provided");
  }
}

export async function GET(req: NextRequest) {
  return handler(req);
}
