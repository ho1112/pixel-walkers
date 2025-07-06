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
        const response = await lineClient.getMessageContent(event.message.id);
        const buffer = await streamToBuffer(response as unknown as Stream);
        const imageBase64 = buffer.toString('base64');

        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const prompt = "이 이미지에 보이는 랜드마크의 이름은 무엇인가요? 이 장소에 대해 모르는 사람에게 설명하듯이, 역사나 특징을 포함해서 3문장으로 친절하게 설명해주세요.";
        
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