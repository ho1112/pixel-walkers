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
      // 사용자 ID가 없는 이벤트는 처리하지 않음
      if (!event.source || !event.source.userId) {
        continue;
      }
      const userId = event.source.userId;

      // 이미지 메시지를 받았을 때만 처리
      if (event.type === 'message' && event.message.type === 'image') {
        // --- 언어 취득! ---
        let userLanguage = 'ja'; // 기본 언어를 일본어로 설정
        try {
          // 1. userId로 사용자의 프로필 정보를 직접 조회
          const profile = await lineClient.getProfile(userId);
          // 2. 프로필 정보에 language가 있으면 해당 값으로 교체
          if (profile.language) {
            userLanguage = profile.language;
            console.log(`✅ 사용자 언어 감지 성공: ${userLanguage}`);
          }
        } catch (profileError) {
          console.error(`프로필 정보 조회 실패 (사용자: ${userId}):`, profileError);
          // 프로필 조회에 실패해도 기본 언어(ja)로 계속 진행
        }
        // -------------------------

        const responseStream = await lineClient.getMessageContent(event.message.id);
        const buffer = await streamToBuffer(responseStream as unknown as Stream);
        const imageBase64 = buffer.toString('base64');

        // 빠른 답변을 위해 flash모델로
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        // 프롬프트를 영어로 작성하고, 마지막에 감지된 언어 코드를 변수로 넣어줍니다.
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
    if (error instanceof Error) console.error('❌ Detailed Error:', error.message);
    return NextResponse.json({ status: 'error' }, { status: 500 });
  }
}