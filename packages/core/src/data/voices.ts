/**
 * Edge TTS 内置音色表。
 *
 * 由 scripts/extract-data.py 从 问津-电脑端-v2.1.html 机械抽取。
 * 改数据请改本文件，不要回改 HTML —— 那份已经归档为只读基准。
 */

import type { VoiceOption } from '../types';

export const EDGE_VOICES: readonly VoiceOption[] = [
  {id:'zh-CN-XiaoxiaoNeural',name:'晓晓 · 女声温暖（推荐）'},
  {id:'zh-CN-YunxiNeural',name:'云希 · 男声少年'},
  {id:'zh-CN-YunjianNeural',name:'云健 · 男声沉稳'},
  {id:'zh-CN-XiaoyiNeural',name:'晓伊 · 女声甜美'},
  {id:'zh-CN-YunyangNeural',name:'云扬 · 男声专业'},
  {id:'zh-CN-XiaochenNeural',name:'晓辰 · 女声知性'},
  {id:'zh-CN-shaanxi-XiaoniNeural',name:'晓妮 · 陕西话（老乡音）'},
  {id:'zh-CN-liaoning-XiaobeiNeural',name:'晓北 · 东北话（整活用）'},
  {id:'zh-HK-HiuMaanNeural',name:'港女 · 粤语'},
  {id:'zh-TW-HsiaoChenNeural',name:'晓臻 · 台湾国语'}
];

