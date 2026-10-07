// hello.mjs · 演示入口：走 data 接口写一条、读全部
import { read, write } from '../data/data.mjs';

const row = write('留言', { text: '框架闭环演示', 时间: new Date().toISOString() });
const all = read('留言');
console.log('已写入:', JSON.stringify(row));
console.log('读回', all.length, '条留言');
