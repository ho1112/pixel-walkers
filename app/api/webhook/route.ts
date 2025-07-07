import { NextRequest, NextResponse } from 'next/server';
import {
  Client,
  WebhookEvent,
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

    // 여러 이벤트가 한꺼번에 와도, 순서를 보장하기 위해 for...of 루프로 하나씩 처리합니다.
    for (const event of events) {
      // 각 이벤트를 개별적으로 try...catch로 감싸 안정성을 높입니다.
      try {
        const userId = event.source?.userId;
        const replyToken = event.type === 'message' ? event.replyToken : undefined;

        if (!userId || !replyToken) {
          continue; // 처리할 수 없는 이벤트는 그냥 넘어감
        }

        // 이미지 메시지일 때만 로직 실행
        if (event.type === 'message' && event.message.type === 'image') {
          // 1. 사용자 언어 정보 조회
          // LINE公式アカウントをブロックしているユーザーのプロフィール情報は取得できません。 --> 취득 못하는 경우도 있음 (기본값 'ja')
          let userLanguage = 'ja';
          try {
            const profile = await lineClient.getProfile(userId);
            if (profile.language) {
              userLanguage = profile.language;
            }
          } catch {
            console.error(`프로필 조회 실패 (user: ${userId})`);
          }

          // 2. 이미지 분석 및 답장 보내기
          const responseStream = await lineClient.getMessageContent(event.message.id);
          const buffer = await streamToBuffer(responseStream as unknown as Stream);
          const imageBase64 = buffer.toString('base64');

          const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
          const prompt = `You are a helpful and friendly tour guide. Your tone should be engaging and informative.
          Analyze the user's image.
          Identify the landmark, object, or place in the image.
          If it is a famous place or object, provide a concise but engaging paragraph (about 4-5 sentences) that includes its key characteristics, a fun fact, or its historical significance.
          If you cannot identify it, state that clearly and describe what you see.
          VERY IMPORTANT: You MUST write your entire response in the following language code: ${userLanguage}`;
          const result = await model.generateContent([
            prompt, { inlineData: { data: imageBase64, mimeType: 'image/jpeg' } }
          ]);
          const aiResponseText = result.response.text();

          await lineClient.replyMessage(replyToken, { type: 'text', text: aiResponseText });
        }
      } catch (error) {
        console.error('개별 이벤트 처리 중 에러 발생:', error);
        // 3. 에러 발생 시, 사용자에게 에러 메시지 답장
        const replyToken = event.type === 'message' ? event.replyToken : undefined;
        if (replyToken) {
          const errorMessage = "申し訳ありません、一時的なエラーが発生しました。しばらくしてからもう一度お試しください。\n\n죄송합니다, 일시적인 오류가 발생했습니다. 잠시 후 다시 시도해주세요.\n\nSorry, a temporary error occurred. Please try again later.";
          await lineClient.replyMessage(replyToken, { type: 'text', text: errorMessage });
        }
      }
    }

    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    if (error instanceof Error) console.error('전체 요청 처리 중 에러 발생:', error.message);
    return NextResponse.json({ status: 'error' }, { status: 500 });
  }
}