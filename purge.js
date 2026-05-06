import { Client, GatewayIntentBits, Events } from 'discord.js';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

const TOKEN = process.env.DISCORD_TOKEN;
const ALLOWED_ROLE_ID = '1255803402898898964';

client.once(Events.ClientReady, (c) => {
    console.log(`✅ Logged in as ${c.user.tag}`);
});

/**
 * 取得しながら削除を実行
 * @param {TextChannel} channel 
 * @param {string|null} startMessageId 起点となるメッセージID
 */
async function purgeMessages(channel, startMessageId) {
    const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
    const now = Date.now();
    const limitTimestamp = now - THREE_HOURS_MS;
    const bulkDeleteLimit = now - (14 * 24 * 60 * 60 * 1000); // 14日制限

    // 起点となるID。引数があればその次(before)から、なければ最新から。
    let lastId = startMessageId;
    let totalDeleted = 0;
    let continueLoop = true;

    console.log(`--- 削除開始 (起点ID: ${lastId || '最新'}) ---`);

    try {
        while (continueLoop) {
            const options = { limit: 100 };
            if (lastId) options.before = lastId;

            const fetched = await channel.messages.fetch(options);
            if (fetched.size === 0) {
                console.log('取得できるメッセージがなくなりました。');
                break;
            }

            // 削除対象のフィルタリング
            const targets = fetched.filter(msg => 
                msg.createdTimestamp > limitTimestamp && 
                msg.createdTimestamp > bulkDeleteLimit
            );

            if (targets.size > 0) {
                const deleted = await channel.bulkDelete(targets, true);
                totalDeleted += deleted.size;
                console.log(`${deleted.size} 件削除（累計: ${totalDeleted}）`);
            }

            // 終了判定のロジック:
            // 取得した100件の中に、3時間より古いメッセージが含まれていれば、
            // それより先（過去）を追う必要がないため終了。
            const hasReachedLimit = fetched.some(msg => msg.createdTimestamp <= limitTimestamp);
            const hasReachedOldLimit = fetched.some(msg => msg.createdTimestamp <= bulkDeleteLimit);

            if (hasReachedLimit || hasReachedOldLimit) {
                console.log('境界線（3時間前または14日前）に到達しました。');
                continueLoop = false;
            }

            // 次のバッチの起点IDを更新
            lastId = fetched.lastKey();

            // 100件未満ならこれ以上メッセージはない
            if (fetched.size < 100) break;

            // レートリミット回避
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        console.log(`--- 完了: 合計 ${totalDeleted} 件を削除しました ---`);

    } catch (error) {
        console.error('削除中にエラーが発生しました:', error);
    }
}

client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.guild) return;

    // コマンド形式: !purge [message_id]
    if (message.content.startsWith('!purge')) {
        // 1. ロール権限チェック
        if (!message.member.roles.cache.has(ALLOWED_ROLE_ID)) {
            return message.reply('このコマンドを実行する権限がありません。');
        }

        const args = message.content.split(' ');
        const targetId = args[1] || null; // 第2引数があればそれをIDとする

        // コマンドメッセージ自体も削除対象に含めたい場合は先に消すか、
        // purge処理の中で消えるのを待つ
        await purgeMessages(message.channel, targetId);
    }
});

if (!TOKEN) {
    console.error('DISCORD_TOKEN environment variable is missing.');
    process.exit(1);
}

client.login(TOKEN);
