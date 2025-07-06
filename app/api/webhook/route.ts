import { NextRequest, NextResponse } from 'next/server';
import {
  Client,
  TextMessage,
  WebhookEvent,
} from '@line/bot-sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Stream } from 'stream';
import { kv } from '@vercel/kv';

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.LINE_CHANNEL_SECRET || '',
};

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const lineClient = new Client(lineConfig);

async function streamToBuffer(stream: Stream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const events: WebhookEvent[] = body.events;

    for (const event of events) {
      if (event.type !== 'message' || !event.source?.userId) {
        continue;
      }
      const userId = event.source.userId;

      // 1. 텍스트 메시지를 받으면, 언어를 '감지'하고 '저장'합니다.
      if (event.message.type === 'text') {
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

        const langDetectionPrompt = `Please provide only the ISO 639-1 language code for the following text (e.g., 'ko', 'ja', 'en', 'fr'). If you are unsure, respond with 'en'. Text: "${event.message.text}"`;

        const result = await model.generateContent(langDetectionPrompt);
        const detectedLang = result.response.text().trim().toLowerCase();

        // Vercel KV에 사용자의 언어 설정을 저장합니다.
        await kv.set(`user-lang:${userId}`, detectedLang);

        const confirmationModel = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
        const confirmationPrompt = `Translate the following sentence into the language with the ISO 639-1 code '${detectedLang}': "Language has been set. You can now send a photo."`;
        const confirmationResult = await confirmationModel.generateContent(confirmationPrompt);
        const replyText = confirmationResult.response.text();

        await lineClient.replyMessage(event.replyToken, { type: 'text', text: replyText });
        continue;
      }

      // 2. 이미지 메시지를 받으면, '저장된' 언어로 답변합니다.
      if (event.message.type === 'image') {
        // Vercel KV에서 사용자의 언어 설정을 가져옵니다.
        const userLanguage = (await kv.get(`user-lang:${userId}`)) || 'ja';

        const responseStream = await lineClient.getMessageContent(event.message.id);
        const buffer = await streamToBuffer(responseStream as unknown as Stream);
        const imageBase64 = buffer.toString('base64');

        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
        const prompt = `You are a helpful and friendly tour guide for Tokyo.
        Analyze the user's image.
        Identify the landmark in the image.
        If it is a landmark, provide a brief, interesting 3-sentence description about its history or characteristics.
        If it is NOT a landmark, state that clearly and describe what you see.
        VERY IMPORTANT: You MUST write your entire response in the following language code: ${userLanguage}`;

        const result = await model.generateContent([
          prompt,
          { inlineData: { data: imageBase64, mimeType: 'image/jpeg' } },
        ]);
        const aiResponseText = result.response.text();

        const replyMessage: TextMessage = {
          type: 'text',
          text: aiResponseText,
        };
        await lineClient.replyMessage(event.replyToken, replyMessage);
      }
    }
    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    if (error instanceof Error) {
      console.error('❌ Detailed Error:', error.message);
    } else {
      console.error('❌ An unknown error occurred:', error);
    }
    return NextResponse.json({ status: 'error' }, { status: 500 });
  }
}
