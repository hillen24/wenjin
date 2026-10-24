import { createApp } from 'vue';

/* token 必须在 base 之前：base.css 里用到了 --sans / --bg 这些变量。 */
import '@wenjin/ui/tokens.css';
import '@wenjin/ui/base.css';
import '@wenjin/ui/components.css';
/* 手机端专属：安全区、禁回弹、底栏。放最后，允许覆盖前三个。 */
import './mobile.css';

import App from './App.vue';

createApp(App).mount('#app');
