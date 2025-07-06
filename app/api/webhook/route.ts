import { NextRequest, NextResponse } from 'next/server';
import {
  Client,
  WebhookEvent,
  TextMessage,
} from '@line/bot-sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Stream } from 'stream';

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
      if (event.type === 'message' && event.message.type === 'image') {
        const userLanguage = (event.source as { language?: string }).language || 'ja';
        const response = await lineClient.getMessageContent(event.message.id);
        const buffer = await streamToBuffer(response as unknown as Stream);
        const imageBase64 = buffer.toString('base64');

        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const prompt = `You are a helpful and friendly tour guide for Tokyo.
        Analyze the user's image.
        Identify the landmark in the image.
        If it is a landmark, provide a brief, interesting 3-sentence description about its history or characteristics.
        If it is NOT a landmark (e.g., a person, an animal, a generic object), state that clearly and describe what you see.
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
    // 에러가 발생하면, 어떤 에러인지 터미널에 자세히 표시합니다.
    if (error instanceof Error) {
      console.error('❌ Detailed Error:', error.message);
    } else {
      console.error('❌ An unknown error occurred:', error);
    }
    return NextResponse.json({ status: 'error' }, { status: 500 });
  }
}