// https://github.com/oto-lab/makeitaquote/blob/c6b51102901301c25aef7dbeb0a13d407b0ce0ad/index.js

import type { Message as DiscordMessage } from 'discord.js';
import { spawn } from 'node:child_process';

const API_URL = 'https://api.voids.top/fakequote'
const BETA_API_URL = 'https://api.voids.top/fakequotebeta';

export const fetchToBase64 = async (url: string) => {
  try {
    // 1. Fetch the source file data
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP status error: ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    const inputBuffer = Buffer.from(arrayBuffer);

    // 2. Wrap FFmpeg process inside a Promise
    const pngBuffer = await new Promise<Buffer>((resolve, reject) => {
      // Arguments:
      // -i pipe:0  -> Read input from stdin
      // -f image2  -> Force image sequence format
      // -vcodec png -> Encode specifically to PNG
      // pipe:1     -> Output the result to stdout
      const ffmpeg = spawn('ffmpeg', ['-i', 'pipe:0', '-f', 'image2', '-vcodec', 'png', 'pipe:1']);

      const chunks: any[] = [];
      const errorChunks: any[] = [];

      // Collect encoded PNG bytes from stdout
      ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));

      // Collect errors from stderr
      ffmpeg.stderr.on('data', (chunk) => errorChunks.push(chunk));

      // Handle termination
      ffmpeg.on('close', (code) => {
        if (code === 0) {
          resolve(Buffer.concat(chunks));
        } else {
          const errorMsg = Buffer.concat(errorChunks).toString();
          reject(new Error(`FFmpeg exited with code ${code}. Error: ${errorMsg}`));
        }
      });

      ffmpeg.on('error', (err) => reject(err));

      // Write the fetched source file bytes into FFmpeg's stdin and close it
      ffmpeg.stdin.write(inputBuffer);
      ffmpeg.stdin.end();
    });

    // 3. Convert the generated PNG bytes into Base64 Data URL
    const base64String = pngBuffer.toString('base64');
    return `data:image/png;base64,${base64String}`;
  } catch (error) {
    console.error("フェッチまたは変換中にエラーが発生しました:", error);
    return url;
  }
}


// --- 型定義 ---

export interface MiQFormat {
  text: string;
  avatar: string | null;
  username: string;
  display_name: string;
  color: boolean;
  watermark: string;
}

/**
 * @class MiQ
 * @description The MiQ class is designed to create a quote with customizable properties.
 * It uses native fetch and custom markdown removal to eliminate external dependencies.
 */
export class MiQ {
  private format: MiQFormat;

  constructor() {
    this.format = {
      text: '',
      avatar: null,
      username: '',
      display_name: '',
      color: false,
      watermark: ''
    };
  }

  /**
   * 簡易的なマークダウン除去ヘルパー (displus.removeMarkdown の代替)
   */
  private removeMarkdown(text: string): string {
    return text
      // ボールド, イタリック, ストライクスルー, アンダーライン, スポイラーの除去
      .replace(/(\*\*|__|\*|~~|\|\||`)/g, '')
      // コードブロックの除去
      .replace(/```[a-z]*\n([\s\S]*?)\n```/g, '$1');
  }

  /**
   * @function setFromMessage
   * @description Sets the quote properties based on a Discord message object.
   */
  public async setFromMessage(message: DiscordMessage, formatText = false): Promise<this> {
    this.setText(message.content, formatText);

    const avatarUrl = message.member ? message.member.displayAvatarURL() : message.author.displayAvatarURL();
    this.setAvatar(await fetchToBase64(avatarUrl));

    const hasNoDiscriminator = !message.author?.discriminator || message.author?.discriminator === '0';
    const username = hasNoDiscriminator
      ? message.author.username
      : `${message.author.username}#${message.author.discriminator}`;
    this.setUsername(username);

    const displayName = message.member
      ? message.member.displayName
      : (message.author?.globalName ?? message.author.username);
    this.setDisplayname(displayName);

    return this;
  }

  /**
   * @function setFromObject
   * @description Sets the quote properties based on an object.
   */
  public setFromObject(data: Partial<MiQFormat>, formatText = false): this {
    if (data.text !== undefined) this.setText(data.text, formatText);
    if (data.avatar !== undefined) this.setAvatar(data.avatar);
    if (data.username !== undefined) this.setUsername(data.username);
    if (data.display_name !== undefined) this.setDisplayname(data.display_name);
    if (typeof data.color === 'boolean') this.setColor(data.color);
    if (data.watermark !== undefined) this.setWatermark(data.watermark);
    return this;
  }

  /**
   * @function setText
   */
  public setText(text: string, formatText = false): this {
    if (typeof text !== 'string') {
      throw new TypeError('Text must be string');
    }
    if (typeof formatText !== 'boolean') {
      throw new TypeError('formatText must be boolean');
    }

    this.format.text = formatText ? this.removeMarkdown(text) : text;
    return this;
  }

  /**
   * @function setAvatar
   */
  public setAvatar(avatar: string | null): this {
    if (avatar !== null && typeof avatar !== 'string') {
      throw new TypeError('Avatar must be string or null');
    }
    this.format.avatar = avatar;
    return this;
  }

  /**
   * @function setUsername
   */
  public setUsername(username: string): this {
    if (typeof username !== 'string') {
      throw new TypeError('Username must be string');
    }
    this.format.username = username;
    return this;
  }

  /**
   * @function setDisplayname
   */
  public setDisplayname(display_name: string): this {
    if (typeof display_name !== 'string') {
      throw new TypeError('Display name must be string');
    }
    this.format.display_name = display_name;
    return this;
  }

  /**
   * @function setColor
   */
  public setColor(color = false): this {
    if (typeof color !== 'boolean') {
      throw new TypeError('Color must be boolean');
    }
    this.format.color = color;
    return this;
  }

  /**
   * @function setWatermark
   */
  public setWatermark(watermark: string): this {
    if (typeof watermark !== 'string') {
      throw new TypeError('Watermark must be string');
    }
    this.format.watermark = watermark;
    return this;
  }

  /**
   * @function generate
   * @description Generates the quote by sending a request using native fetch API.
   */
  public async generate(returnRawImage = false): Promise<string> {
    if (!this.format.text) {
      throw new Error('Text is required');
    }
    if (typeof returnRawImage !== 'boolean') {
      throw new TypeError('returnRawImage must be boolean');
    }

    try {
      // POSTリクエストの送信
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.format),
      });

      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`Status: ${response.status}, Data: ${errorData}`);
      }

      const resData = (await response.json()) as { url: string };
      return resData.url;
    } catch (error: any) {
      throw new Error(`Failed to generate quote: ${error.message}`);
    }
  }

  /**
   * @function generateBeta
   * @description Generates the quote by sending a request to the beta API.
   */
  public async generateBeta(): Promise<Buffer> {
    if (!this.format.text) {
      throw new Error('Text is required');
    }

    try {
      const response = await fetch(BETA_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.format),
      });

      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`Status: ${response.status}, Data: ${errorData}`);
      }

      // レスポンスを直接ArrayBufferとして取得し、Bufferに変換
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error: any) {
      throw new Error(`Failed to generate quote: ${error.message}`);
    }
  }

  /**
   * @function getFormat
   */
  public getFormat(): MiQFormat {
    return this.format;
  }
}
