import { NextRequest, NextResponse } from 'next/server';
import {
  Client,
  WebhookEvent,
  TextMessage,
} from '@line/bot-sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Stream } from 'stream'; // Node.js의 Stream 타입을 가져옵니다.

// .env.local 파일에서 설정한 값들을 가져옵니다.
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.LINE_CHANNEL_SECRET || '',
};

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const lineClient = new Client(lineConfig);

// <<-- 이 함수를 새로운 버전으로 교체! -->>
// Node.js Stream을 Buffer로 변환하는 수정된 헬퍼 함수
async function streamToBuffer(stream: Stream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => {
      chunks.push(chunk);
    });
    stream.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    stream.on('error', reject);
  });
}

// LINE의 GET 리퀘스트 확인용
export async function GET() {
  return NextResponse.json({
    status: 'success',
    message: "Webhook is active. Ready to receive POST requests from LINE." 
  });
}

// LINE의 요청을 처리하는 핵심 함수
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const events: WebhookEvent[] = body.events;

    for (const event of events) {
      if (event.type === 'message' && event.message.type === 'image') {
        // 1. LINE 서버로부터 이미지 콘텐츠(Stream) 가져오기
        const response = await lineClient.getMessageContent(event.message.id);
        
        // 2. Stream을 Buffer로, Buffer를 Base64 문자열로 변환
        const buffer = await streamToBuffer(response as unknown as Stream);
        const imageBase64 = buffer.toString('base64');

        // 3. Gemini Vision API 호출
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const prompt = "이 이미지에 보이는 랜드마크의 이름은 무엇인가요? 이 장소에 대해 모르는 사람에게 설명하듯이, 역사나 특징을 포함해서 3문장으로 친절하게 설명해주세요.";
        
        const result = await model.generateContent([
          prompt,
          { inlineData: { data: imageBase64, mimeType: 'image/jpeg' } },
        ]);
        
        const aiResponseText = result.response.text();
        console.log('🤖 AI의 답변:', aiResponseText);

        // 4. 분석 결과를 사용자에게 답장으로 보내기
        const replyMessage: TextMessage = {
          type: 'text',
          text: aiResponseText,
        };
        await lineClient.replyMessage(event.replyToken, replyMessage);
      }
    }

    return NextResponse.json({ status: 'ok' });

  } catch (error) {
    console.error('❌ 에러 발생:', error);
    return NextResponse.json({ status: 'error' }, { status: 500 });
  }
}