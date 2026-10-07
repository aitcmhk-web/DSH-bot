// tg.mjs · TG 通道适配器（D12 三件套：收/发/归一）
// 收=pollOnce（拉新消息，offset 只记内存·零数据）；发=access.send（唯一判据 message_id 内置）；
// 归一=convert.normalize（文件拉取落临时文件、语音归一 mp3、图片归一 jpg/png 都在管道里）。
import { pollOnce, send } from '../access/access.mjs';
import { normalize } from '../convert/convert.mjs';

export function createTgChannel(item) {
  if (!item?.token) throw new Error(`TG 适配器缺 token：${item?.项目 ?? '未知项目'}`);
  let offset = 0; // 零数据：游标只记内存，重启从 0 重拉（服务端去重）
  return {
    通道: 'tg',
    token: item.token,
    项目: item.项目,
    item, // 打包器要读 配置项（打包间隔秒/回显/项目名）
    轮询间隔ms: 1500,
    重试次数: 3, // access.send 无内置重试，外层安全发送补足三件套
    async 收() {
      const r = await pollOnce(item.token, offset);
      offset = r.offset;
      return { 消息们: r.消息, 失败们: r.失败 }; // 单条归一失败已在 pollOnce 进失败清单（不卡通道）
    },
    归一(原始) {
      return normalize(原始);
    },
    async 发(chatId, 内容) {
      return send(item.token, 'tg', chatId, 内容); // 富文本/媒体/本地路径 multipart 都在 access 里
    },
  };
}
