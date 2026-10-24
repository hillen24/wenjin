/**
 * 星图：节点与边。节点是概念/人物/学派，边是它们之间的思想关系。
 *
 * 由 scripts/extract-data.py 从 问津-电脑端-v2.1.html 机械抽取。
 * 改数据请改本文件，不要回改 HTML —— 那份已经归档为只读基准。
 */

import type { StarNode, StarEdge } from '../types';

export const STAR_NODES: readonly StarNode[] = [
 {id:'stoic',name:'斯多葛学派',kind:'school',school:'希腊化罗马',brief:'晚期古希腊罗马四大流派之一，主张德性即唯一的善，以理性驯服情绪。',src:'芝诺创立，经爱比克泰德、马可·奥勒留传世',doc:{d:'epictetus',p:0}},
 {id:'epictetus',name:'爱比克泰德',kind:'figure',school:'希腊化罗马',brief:'从奴隶到哲人。其《论说集》开篇即把世界一刀切成"能力之内"与"能力之外"。',src:'《爱比克泰德论说集》',doc:{d:'epictetus',p:0}},
 {id:'dichotomy',name:'控制二分法',kind:'method',school:'希腊化罗马',brief:'方法论 A1：把事物分为可控与不可控，只对可控部分使力，对不可控部分练习"愿意其发生"。',src:'爱比克泰德《论说集》卷一',doc:{d:'epictetus',p:0},entries:['A1']},
 {id:'amorfati',name:'命运之爱',kind:'method',school:'现代欧陆',brief:'方法论 A3：不只要忍受发生的事，还要爱上它——它是你唯一的素材。',src:'尼采《瞧，这个人》',doc:null,entries:['A3']},
 {id:'nietzsche',name:'尼采',kind:'figure',school:'现代欧陆',brief:'"上帝死了"的宣布者，重估一切价值，哲学在他的锤下变成手术刀。',src:'《善恶的彼岸》《瞧，这个人》',doc:null},
 {id:'epicurus',name:'伊壁鸠鲁',kind:'figure',school:'希腊化罗马',brief:'被误解最深的哲人——他的快乐主义其实是极简主义：无痛苦的平静即至福。',src:'《致美诺西乌的信》',doc:null},
 {id:'desire3',name:'欲望三分',kind:'method',school:'希腊化罗马',brief:'方法论 A4：欲望分自然且必要 / 自然但不必要 / 虚妄三类，管好第一类就获得自由的基础。',src:'伊壁鸠鲁学派',doc:null,entries:['A4']},
 {id:'kant',name:'康德',kind:'figure',school:'德国古典',brief:'被休谟的怀疑"从独断论迷梦中唤醒"，用先验哲学给知识重新打地基。',src:'《纯粹理性批判》',doc:null},
 {id:'dingziti',name:'物自体',kind:'concept',school:'德国古典',brief:'物自体不可知——我们认识的永远是经过感性形式加工的现象。这是康德的著名切口。',src:'《纯粹理性批判》',doc:null},
 {id:'hume',name:'休谟',kind:'figure',school:'现代英美',brief:'怀疑论大师：因果性不是世界固有的，只是我们习惯性的心理联想。',src:'《人性论》',doc:null},
 {id:'causation',name:'因果关系',kind:'concept',school:'现代英美',brief:'休谟之问：我们凭什么说"因为A所以B"？除了"总是看到它们相伴"，我们没有更多证据。',src:'休谟《人性论》',doc:null},
 {id:'utilitarianism',name:'功利主义',kind:'concept',school:'现代英美',brief:'方法论 B10：行为的对错只看后果——最大多数人的最大幸福。',src:'边沁、密尔',doc:null,entries:['B10']},
 {id:'bentham',name:'边沁',kind:'figure',school:'现代英美',brief:'功利主义创始人，想把伦理学变成算术：幸福可计量、可加总、可比较。',src:'《道德与立法原理导论》',doc:null},
 {id:'veil',name:'无知之幕',kind:'method',school:'现代英美',brief:'方法论 B9：设计规则时假设不知道自己将是规则下的谁——正义的判断要去身份化。',src:'罗尔斯《正义论》',doc:null,entries:['B9']},
 {id:'rawls',name:'罗尔斯',kind:'figure',school:'现代英美',brief:'用"无知之幕"重建正义论，直接对冲功利主义对个体权利的吞并。',src:'《正义论》',doc:null},
 {id:'epoche',name:'现象学悬置',kind:'method',school:'现象学',brief:'方法论 B2：把"它是不是真的"这个判断加括号存起来，先看现象本身如何呈现。',src:'胡塞尔《观念Ⅰ》',doc:null,entries:['B2']},
 {id:'husserl',name:'胡塞尔',kind:'figure',school:'现象学',brief:'"面向事情本身！"——暂停一切成见，让现象自己说话。',src:'《现象学的观念》',doc:null},
 {id:'occam',name:'奥卡姆剃刀',kind:'method',school:'中世纪',brief:'方法论 B1：两个解释都能说明现象时，选假设更少的那个。如无必要，勿增实体。',src:'奥卡姆的威廉',doc:null,entries:['B1']},
 {id:'occamW',name:'奥卡姆的威廉',kind:'figure',school:'中世纪',brief:'14 世纪方济各会士，逻辑学家。"剃刀"这个词其实是后人加的。',src:'《箴言书注疏》',doc:null},
 {id:'midwife',name:'产婆术',kind:'method',school:'古希腊',brief:'方法论 B6/C：苏格拉底式追问六式——澄清、假设、证据、视角、后果、元问题。答案在对方心里，只是生不出来。',src:'柏拉图《泰阿泰德篇》',doc:null,entries:['B6']},
 {id:'socrates',name:'苏格拉底',kind:'figure',school:'古希腊',brief:'雅典的"牛虻"，自称一无所知。他不是在讲授，他是在追问。',src:'柏拉图早期对话录',doc:null},
 {id:'zhuangzi',name:'庄子',kind:'figure',school:'先秦中国',brief:'用寓言消解问题的哲人。当康德在分析，庄子已经在说"狙猿之巧于山林"。',src:'《庄子》',doc:{d:'zhuangzi',p:0}},
 {id:'paoding',name:'庖丁解牛',kind:'method',school:'先秦中国',brief:'方法论 A10：顺应事物的结构游走（以无厚入有间），不硬碰。前提是看了十九年牛的深厚积累。',src:'《庄子·养生主》',doc:{d:'zhuangzi',p:1},entries:['A10']},
 {id:'zhixing',name:'知行合一',kind:'method',school:'明代中国',brief:'方法论 A11：知而不行只是未知。真知必然带出行动，行动也是知的完成。',src:'王阳明《传习录》',doc:{d:'zhuangzi',p:2},entries:['A11']},
 {id:'wangym',name:'王阳明',kind:'figure',school:'明代中国',brief:'心学集大成者。龙场一悟：心即理，知行本是一件事。',src:'《传习录》',doc:null},
 {id:'doubt',name:'普遍怀疑',kind:'method',school:'现代欧陆',brief:'方法论 B3：系统性怀疑一切可疑的，直到找到不可疑的地基再重建。',src:'笛卡尔《第一哲学沉思集》',doc:null,entries:['B3']},
 {id:'descartes',name:'笛卡尔',kind:'figure',school:'现代欧陆',brief:'"我思故我在"——用怀疑烧掉一切，最后剩下一块烧不掉的地基。',src:'《第一哲学沉思集》',doc:null},
 {id:'laotzi',name:'老子',kind:'figure',school:'先秦中国',brief:'道家始祖。五千言《道德经》以水喻道：不争，故天下莫能与之争。',src:'《道德经》',doc:{d:'laotzi',p:0}},
 {id:'confucius',name:'孔子',kind:'figure',school:'先秦中国',brief:'万世师表。把「做个好人」拆成日日可练的功夫：三省、好学、和而不同。',src:'《论语》',doc:{d:'lunyu',p:0}},
 {id:'xiaoyao',name:'逍遥游',kind:'method',school:'先秦中国',brief:'无待而游：鲲鹏之大不靠风，至人之游不靠外物。格局决定你飞多远。',src:'《庄子·逍遥游》',doc:{d:'xiaoyao',p:2}}
];

export const STAR_EDGES: readonly StarEdge[] = [
 ['epictetus','dichotomy','proposes','系统阐述'],['stoic','dichotomy','proposes','学派总纲'],
 ['nietzsche','amorfati','proposes','命名并阐发'],['dichotomy','amorfati','refines','递进：从接受到热爱'],
 ['amorfati','stoic','inherits','斯多葛晚期已有此源流'],
 ['epicurus','desire3','proposes',''],['kant','dingziti','proposes',''],
 ['hume','kant','refines','休谟的怀疑唤醒康德'],['hume','causation','opposes','质疑因果必然性'],
 ['bentham','utilitarianism','proposes',''],['utilitarianism','veil','opposes','后果计算 vs 个体权利'],
 ['rawls','veil','proposes',''],['utilitarianism','kant','opposes','后果论 vs 义务论'],
 ['husserl','epoche','proposes',''],['epoche','doubt','inherits','悬置继承怀疑传统'],
 ['descartes','doubt','proposes',''],
 ['occamW','occam','proposes',''],['socrates','midwife','proposes',''],
 ['zhuangzi','paoding','proposes',''],['wangym','zhixing','proposes',''],
 ['paoding','zhixing','refines','顺应结构与知行本体相通'],
 ['zhuangzi','laotzi','inherits','庄子承老子，以寓言弘其道'],
 ['zhuangzi','xiaoyao','proposes','逍遥游为庄子自铸的方法'],
 ['wangym','confucius','inherits','心学承儒门：致良知即致知'],
 ['confucius','laotzi','opposes','儒道分途：日日精进与无为而治']
];

