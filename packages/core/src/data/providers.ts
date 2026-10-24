/**
 * AI 服务商定义。key: true 表示必须配 API Key 才能调用。
 *
 * 由 scripts/extract-data.py 从 问津-电脑端-v2.1.html 机械抽取。
 * 改数据请改本文件，不要回改 HTML —— 那份已经归档为只读基准。
 */

import type { ProviderDef } from '../types';

export const PROVIDERS: Record<string, ProviderDef> = {
  ollama:{name:'本地 Ollama',base:'http://127.0.0.1:11434/v1',model:'qwen2.5:7b',key:false,note:'局域网常驻主机，断网也能用'},
  deepseek:{name:'DeepSeek',base:'https://api.deepseek.com/v1',model:'deepseek-chat',key:true,note:'复杂讲解/批改的兜底'},
  siliconflow:{name:'硅基流动',base:'https://api.siliconflow.cn/v1',model:'deepseek-ai/DeepSeek-V3',key:true,note:'国内聚合，模型多'},
  custom:{name:'自定义（OpenAI 兼容）',base:'',model:'',key:true,note:'任何兼容 /chat/completions 的服务'}
};

