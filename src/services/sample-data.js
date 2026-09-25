'use strict';

/**
 * 测试样本数据生成器。
 *
 * 用途：后台「新增账号」表单的「随机生成」按钮，一键填充一份格式合规的测试数据。
 *
 * 关于数据来源的说明（重要）：
 *   互联网上不存在可直接抓取的「护士执业注册」公开样本数据集 —— 这类数据
 *   属于个人敏感信息，不会以开放 API 的形式对外提供。任何声称可随意抓取的
 *   来源都不可信、也不合规。
 *
 *   因此这里采用业内通行的做法：**按真实字段规则合成测试数据**。
 *   - 身份证号：地区码 + 出生日期 + 顺序码 + GB 11643 校验位（校验位真实计算）
 *   - 证书编号、机构、科室、职称等：取自公开的行政区划/医疗机构命名规则与职称序列
 *   - 所有姓名均为「常见姓氏 + 常见名字」的随机组合，不对应任何真实个人
 *
 *   这样既能满足测试需要，又不存在隐私与合规风险。
 *   若后续要接入真实数据源，只需替换 `pickSample()` 的实现（改为调用你的数据接口）。
 */

/* ------------------------------------------------------------------ *
 * 基础数据池
 * ------------------------------------------------------------------ */

const SURNAMES = [
  '王', '李', '张', '刘', '陈', '杨', '赵', '黄', '周', '吴',
  '徐', '孙', '胡', '朱', '高', '林', '何', '郭', '马', '罗',
  '梁', '宋', '郑', '谢', '韩', '唐', '冯', '于', '董', '萧',
];

const GIVEN_NAME_CHARS = [
  '秀', '丽', '敏', '静', '娟', '英', '华', '芳', '燕', '娜',
  '强', '军', '磊', '洋', '勇', '杰', '涛', '明', '超', '峰',
  '雅', '雪', '梅', '兰', '婷', '悦', '欣', '佳', '思', '雨',
  '文', '博', '宇', '轩', '晨', '阳', '志', '建', '国', '伟',
];

/** 行政区划代码（前 6 位）—— 取真实地级市代码，与医院所在城市保持一致 */
const REGIONS = [
  { code: '320300', city: '徐州市', province: '江苏省' },
  { code: '320100', city: '南京市', province: '江苏省' },
  { code: '320500', city: '苏州市', province: '江苏省' },
  { code: '310100', city: '上海市', province: '上海市' },
  { code: '110100', city: '北京市', province: '北京市' },
  { code: '440100', city: '广州市', province: '广东省' },
  { code: '440300', city: '深圳市', province: '广东省' },
  { code: '330100', city: '杭州市', province: '浙江省' },
  { code: '510100', city: '成都市', province: '四川省' },
  { code: '420100', city: '武汉市', province: '湖北省' },
  { code: '370100', city: '济南市', province: '山东省' },
  { code: '610100', city: '西安市', province: '陕西省' },
];

/** 医疗机构名称模板：城市名 + 规范的后缀，避免出现「中医人民医院」这类不自然组合 */
const HOSPITAL_TEMPLATES = [
  (city) => `${city}第一人民医院`,
  (city) => `${city}第二人民医院`,
  (city) => `${city}第三人民医院`,
  (city) => `${city}中心医院`,
  (city) => `${city}人民医院`,
  (city) => `${city}中医院`,
  (city) => `${city}妇幼保健院`,
  (city) => `${city}第一中医院`,
  (city) => `${city}第二中医院`,
];

/** 科室（护理岗位常见科室） */
const DEPARTMENTS = [
  '心内科门诊', '呼吸内科', '消化内科', '神经内科', '内分泌科',
  '普外科', '骨科', '泌尿外科', '妇产科', '儿科',
  '急诊科', '重症医学科（ICU）', '手术室', '肿瘤科', '康复医学科',
  '血液透析中心', '感染性疾病科', '眼科', '耳鼻咽喉科', '护理部',
];

const WORK_CATEGORIES = ['临床护理', '护理管理', '护理教学', '社区护理', '公共卫生护理'];

const POSITIONS = ['护士', '护师', '责任护士', '护理组长', '副护士长', '护士长'];

const TITLES = ['护士', '护师', '主管护师', '副主任护师', '主任护师'];

const APPROVAL_AUTHORITIES = [
  '卫生健康委员会', '卫生健康局', '中医药管理局',
];

const NATIONS = ['中国'];
const ETHNICITIES = ['汉族', '回族', '满族', '壮族', '苗族', '维吾尔族', '蒙古族', '土家族'];
const HEALTH_STATUS = ['健康状况良好', '健康状况一般', '健康状况良好'];

/* ------------------------------------------------------------------ *
 * 随机工具
 * ------------------------------------------------------------------ */

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** 生成 YYYY-MM-DD */
function formatDate(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 在 [startYear, endYear] 内随机取一天 */
function randomDate(startYear, endYear) {
  const year = randomInt(startYear, endYear);
  const month = randomInt(1, 12);
  // 每月最大天数按 28 处理，避免出现 2 月 30 日这类无效日期
  const day = randomInt(1, 28);
  return formatDate(new Date(Date.UTC(year, month - 1, day)));
}

/* ------------------------------------------------------------------ *
 * 身份证号（GB 11643-1999 校验位，真实计算）
 * ------------------------------------------------------------------ */

const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CHECK_CODES = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];

/** 计算 18 位身份证的第 18 位校验码 */
function idCheckDigit(first17) {
  let sum = 0;
  for (let i = 0; i < 17; i += 1) {
    sum += Number(first17[i]) * ID_WEIGHTS[i];
  }
  return ID_CHECK_CODES[sum % 11];
}

/** 生成一个校验位正确的 18 位身份证号 */
function makeIdCard(regionCode, birthDate) {
  const datePart = birthDate.replace(/-/g, '');
  const sequence = String(randomInt(1, 999)).padStart(3, '0');
  const first17 = `${regionCode}${datePart}${sequence}`;
  return first17 + idCheckDigit(first17);
}

/* ------------------------------------------------------------------ *
 * 样本生成
 * ------------------------------------------------------------------ */

/** 生成一个中文姓名（常见姓氏 + 1~2 个常见名字用字） */
function makeName() {
  const surname = pick(SURNAMES);
  const len = Math.random() < 0.55 ? 2 : 1;
  let given = '';
  for (let i = 0; i < len; i += 1) {
    given += pick(GIVEN_NAME_CHARS);
  }
  return surname + given;
}

/**
 * 生成一份完整的护士执业注册测试样本。
 * 返回结构与后端 `profile` 白名单字段一致，可直接填入表单。
 */
function makeSample() {
  const region = pick(REGIONS);
  const gender = Math.random() < 0.85 ? '女' : '男';

  // 出生日期：护士入职年龄通常在 20~45 岁之间
  const birthDate = randomDate(1980, 2004);

  const examDate = randomDate(2004, 2023);          // 通过考试时间
  const workStartDate = formatDate(new Date(
    Date.UTC(
      Number(examDate.slice(0, 4)) + randomInt(0, 1),
      randomInt(0, 11),
      randomInt(1, 28)
    )
  ));

  // 注册有效期：自批准日起 5 年
  const approvalDate = randomDate(2020, 2025);
  const expireDate = formatDate(new Date(
    Date.UTC(Number(approvalDate.slice(0, 4)) + 5, Number(approvalDate.slice(5, 7)) - 1, Number(approvalDate.slice(8, 10)))
  ));

  const hospital = pick(HOSPITAL_TEMPLATES)(region.city);

  return {
    姓名: makeName(),
    性别: gender,
    执业注册状态: '在册',
    出生日期: birthDate,
    国籍: '中国',
    民族: pick(ETHNICITIES),
    身份证号: makeIdCard(region.code, birthDate),
    护士执业证书编号: String(randomInt(10000000000, 99999999999)),
    注册有效期至: expireDate,
    通过考试时间: examDate,
    健康状况: pick(HEALTH_STATUS),
    参加工作时间: workStartDate,
    执业机构: hospital,
    工作科室: pick(DEPARTMENTS),
    工作类别: pick(WORK_CATEGORIES),
    职务: pick(POSITIONS),
    技术职称: pick(TITLES),
    审批机关: `${region.city}${pick(APPROVAL_AUTHORITIES)}`,
    审批时间: approvalDate,
    头像: '',
  };
}

/**
 * 取一批样本。
 * 若将来要改为「从外部数据源获取」，只需改这个函数内部实现，
 * 保持同样的返回结构即可，前端无需改动。
 *
 * @param {number} count 需要几条
 * @returns {object[]} 样本数组
 */
function pickSample(count = 1) {
  const total = Math.max(1, Math.min(Number(count) || 1, 20));
  const list = [];
  // 循环内简单去重，避免同一批出现重复身份证号
  const seen = new Set();
  let guard = 0;

  while (list.length < total && guard < total * 30) {
    guard += 1;
    const item = makeSample();
    if (seen.has(item.身份证号)) continue;
    seen.add(item.身份证号);
    list.push(item);
  }

  return list;
}

module.exports = { pickSample, makeSample, NATIONS, ETHNICITIES, HEALTH_STATUS };
