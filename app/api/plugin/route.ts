import { ChatGPTPluginRetriever } from "langchain/retrievers";
import { NextRequest, NextResponse } from "next/server";

async function handler(req: NextRequest) {
  const query = req.nextUrl.searchParams.get("query") as string | undefined;
  const bearer = process.env.BEARER as string;

  const apiKey = process.env.OPENAI_API_KEY as string;

  const retriever = new ChatGPTPluginRetriever({
    url: "https://chatgpt-retrieval-plugin-production-7a30.up.railway.app",
    auth: {
      bearer: bearer,
    },
    topK: 3,
  });

  if (apiKey) {
    console.log("[Auth] set system token");
  } else {
    return NextResponse.json(
      JSON.stringify("No Api Key provided"),

      {
        status: 500,
      },
    );
  }

  if (query != null) {
    const docs = await retriever.getRelevantDocuments(query);
    return NextResponse.json(JSON.stringify(docs), {
      status: 200,
    });
  } else {
    return NextResponse.json(JSON.stringify("No Query provided"), {
      status: 500,
    });
  }
}

export async function GET(req: NextRequest) {
  return handler(req);
}
