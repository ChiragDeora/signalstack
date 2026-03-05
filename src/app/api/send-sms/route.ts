import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { to, alert } = body;
    
    if (!to || !alert) {
      return NextResponse.json({ error: 'Missing phone number or alert data' }, { status: 400 });
    }
    
    // Format phone number (remove any formatting)
    const phoneNumber = to.replace(/[^\d+]/g, '');
    
    // SMS content (keep it short due to SMS limits)
    const smsMessage = `🚨 ${alert.symbol} EMA Alert
${alert.type.toUpperCase()}: ₹${alert.price}
EMA(${alert.ema1Period}) x EMA(${alert.ema2Period})
${new Date(alert.timestamp).toLocaleTimeString()}`;
    
    // In a real implementation, you would use a service like:
    // - Twilio
    // - AWS SNS
    // - Vonage (Nexmo)
    // - TextMagic
    // - Fast2SMS (for India)
    
    console.log(`📱 SMS Alert [SIMULATION]`);
    console.log(`To: ${phoneNumber}`);
    console.log(`Message: ${smsMessage}`);
    
    // Simulate SMS sending delay
    await new Promise(resolve => setTimeout(resolve, 800));
    
    return NextResponse.json({ 
      success: true, 
      message: 'SMS alert sent successfully',
      simulation: true,
      details: {
        to: phoneNumber,
        message: smsMessage,
        timestamp: new Date().toISOString(),
        length: smsMessage.length
      }
    });
    
  } catch (error) {
    console.error('Error sending SMS alert:', error);
    return NextResponse.json({ error: 'Failed to send SMS alert' }, { status: 500 });
  }
}

// Example implementation with Twilio:
/*
import twilio from 'twilio';

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

await client.messages.create({
  body: smsMessage,
  from: process.env.TWILIO_PHONE_NUMBER,
  to: phoneNumber
});
*/

// Example implementation with Fast2SMS (India):
/*
import axios from 'axios';

await axios.post('https://www.fast2sms.com/dev/bulk', {
  authorization: process.env.FAST2SMS_API_KEY,
  sender_id: 'TXTIND',
  message: smsMessage,
  language: 'english',
  route: 'p',
  numbers: phoneNumber
});
*/