import { pinyin } from 'pinyin-pro'

export interface LocalBillingAddress {
  province: string
  city: string
  district: string
  pinyinCity: string
  pinyinDistrict: string
  addressLine1: string
  postalCode: string
}

export interface BillingRegion {
  province: string
  city: string
  district: string
}

/**
 * 中国大陆省级行政区与地级行政单位的本地账单数据。
 * 每条记录绑定同一城市下真实存在的区、县或县级市，避免拼接出跨区域地址。
 * 省份保留中文，城市和地区由 billingPinyin 转为支付表单需要的拼音。
 */
export const BILLING_REGIONS = [
  { province: '北京市', city: '北京市', district: '海淀区' },
  { province: '天津市', city: '天津市', district: '和平区' },
  { province: '河北省', city: '石家庄市', district: '长安区' },
  { province: '河北省', city: '唐山市', district: '路北区' },
  { province: '河北省', city: '秦皇岛市', district: '海港区' },
  { province: '河北省', city: '邯郸市', district: '丛台区' },
  { province: '河北省', city: '邢台市', district: '襄都区' },
  { province: '河北省', city: '保定市', district: '莲池区' },
  { province: '河北省', city: '张家口市', district: '桥东区' },
  { province: '河北省', city: '承德市', district: '双桥区' },
  { province: '河北省', city: '沧州市', district: '运河区' },
  { province: '河北省', city: '廊坊市', district: '广阳区' },
  { province: '河北省', city: '衡水市', district: '桃城区' },
  { province: '山西省', city: '太原市', district: '小店区' },
  { province: '山西省', city: '大同市', district: '平城区' },
  { province: '山西省', city: '阳泉市', district: '城区' },
  { province: '山西省', city: '长治市', district: '潞州区' },
  { province: '山西省', city: '晋城市', district: '城区' },
  { province: '山西省', city: '朔州市', district: '朔城区' },
  { province: '山西省', city: '晋中市', district: '榆次区' },
  { province: '山西省', city: '运城市', district: '盐湖区' },
  { province: '山西省', city: '忻州市', district: '忻府区' },
  { province: '山西省', city: '临汾市', district: '尧都区' },
  { province: '山西省', city: '吕梁市', district: '离石区' },
  { province: '内蒙古自治区', city: '呼和浩特市', district: '新城区' },
  { province: '内蒙古自治区', city: '包头市', district: '昆都仑区' },
  { province: '内蒙古自治区', city: '乌海市', district: '海勃湾区' },
  { province: '内蒙古自治区', city: '赤峰市', district: '红山区' },
  { province: '内蒙古自治区', city: '通辽市', district: '科尔沁区' },
  { province: '内蒙古自治区', city: '鄂尔多斯市', district: '东胜区' },
  { province: '内蒙古自治区', city: '呼伦贝尔市', district: '海拉尔区' },
  { province: '内蒙古自治区', city: '巴彦淖尔市', district: '临河区' },
  { province: '内蒙古自治区', city: '乌兰察布市', district: '集宁区' },
  { province: '内蒙古自治区', city: '兴安盟', district: '乌兰浩特市' },
  { province: '内蒙古自治区', city: '锡林郭勒盟', district: '锡林浩特市' },
  { province: '内蒙古自治区', city: '阿拉善盟', district: '阿拉善左旗' },
  { province: '辽宁省', city: '沈阳市', district: '和平区' },
  { province: '辽宁省', city: '大连市', district: '中山区' },
  { province: '辽宁省', city: '鞍山市', district: '铁东区' },
  { province: '辽宁省', city: '抚顺市', district: '新抚区' },
  { province: '辽宁省', city: '本溪市', district: '平山区' },
  { province: '辽宁省', city: '丹东市', district: '振兴区' },
  { province: '辽宁省', city: '锦州市', district: '古塔区' },
  { province: '辽宁省', city: '营口市', district: '站前区' },
  { province: '辽宁省', city: '阜新市', district: '海州区' },
  { province: '辽宁省', city: '辽阳市', district: '白塔区' },
  { province: '辽宁省', city: '盘锦市', district: '兴隆台区' },
  { province: '辽宁省', city: '铁岭市', district: '银州区' },
  { province: '辽宁省', city: '朝阳市', district: '双塔区' },
  { province: '辽宁省', city: '葫芦岛市', district: '龙港区' },
  { province: '吉林省', city: '长春市', district: '朝阳区' },
  { province: '吉林省', city: '吉林市', district: '船营区' },
  { province: '吉林省', city: '四平市', district: '铁西区' },
  { province: '吉林省', city: '辽源市', district: '龙山区' },
  { province: '吉林省', city: '通化市', district: '东昌区' },
  { province: '吉林省', city: '白山市', district: '浑江区' },
  { province: '吉林省', city: '松原市', district: '宁江区' },
  { province: '吉林省', city: '白城市', district: '洮北区' },
  { province: '吉林省', city: '延边朝鲜族自治州', district: '延吉市' },
  { province: '黑龙江省', city: '哈尔滨市', district: '道里区' },
  { province: '黑龙江省', city: '齐齐哈尔市', district: '龙沙区' },
  { province: '黑龙江省', city: '鸡西市', district: '鸡冠区' },
  { province: '黑龙江省', city: '鹤岗市', district: '向阳区' },
  { province: '黑龙江省', city: '双鸭山市', district: '尖山区' },
  { province: '黑龙江省', city: '大庆市', district: '萨尔图区' },
  { province: '黑龙江省', city: '伊春市', district: '伊美区' },
  { province: '黑龙江省', city: '佳木斯市', district: '向阳区' },
  { province: '黑龙江省', city: '七台河市', district: '桃山区' },
  { province: '黑龙江省', city: '牡丹江市', district: '东安区' },
  { province: '黑龙江省', city: '黑河市', district: '爱辉区' },
  { province: '黑龙江省', city: '绥化市', district: '北林区' },
  { province: '黑龙江省', city: '大兴安岭地区', district: '加格达奇区' },
  { province: '上海市', city: '上海市', district: '浦东新区' },
  { province: '江苏省', city: '南京市', district: '鼓楼区' },
  { province: '江苏省', city: '无锡市', district: '梁溪区' },
  { province: '江苏省', city: '徐州市', district: '云龙区' },
  { province: '江苏省', city: '常州市', district: '钟楼区' },
  { province: '江苏省', city: '苏州市', district: '姑苏区' },
  { province: '江苏省', city: '南通市', district: '崇川区' },
  { province: '江苏省', city: '连云港市', district: '海州区' },
  { province: '江苏省', city: '淮安市', district: '清江浦区' },
  { province: '江苏省', city: '盐城市', district: '亭湖区' },
  { province: '江苏省', city: '扬州市', district: '广陵区' },
  { province: '江苏省', city: '镇江市', district: '京口区' },
  { province: '江苏省', city: '泰州市', district: '海陵区' },
  { province: '江苏省', city: '宿迁市', district: '宿城区' },
  { province: '浙江省', city: '杭州市', district: '拱墅区' },
  { province: '浙江省', city: '宁波市', district: '海曙区' },
  { province: '浙江省', city: '温州市', district: '鹿城区' },
  { province: '浙江省', city: '嘉兴市', district: '南湖区' },
  { province: '浙江省', city: '湖州市', district: '吴兴区' },
  { province: '浙江省', city: '绍兴市', district: '越城区' },
  { province: '浙江省', city: '金华市', district: '婺城区' },
  { province: '浙江省', city: '衢州市', district: '柯城区' },
  { province: '浙江省', city: '舟山市', district: '定海区' },
  { province: '浙江省', city: '台州市', district: '椒江区' },
  { province: '浙江省', city: '丽水市', district: '莲都区' },
  { province: '安徽省', city: '合肥市', district: '蜀山区' },
  { province: '安徽省', city: '芜湖市', district: '镜湖区' },
  { province: '安徽省', city: '蚌埠市', district: '蚌山区' },
  { province: '安徽省', city: '淮南市', district: '田家庵区' },
  { province: '安徽省', city: '马鞍山市', district: '花山区' },
  { province: '安徽省', city: '淮北市', district: '相山区' },
  { province: '安徽省', city: '铜陵市', district: '铜官区' },
  { province: '安徽省', city: '安庆市', district: '迎江区' },
  { province: '安徽省', city: '黄山市', district: '屯溪区' },
  { province: '安徽省', city: '滁州市', district: '琅琊区' },
  { province: '安徽省', city: '阜阳市', district: '颍州区' },
  { province: '安徽省', city: '宿州市', district: '埇桥区' },
  { province: '安徽省', city: '六安市', district: '金安区' },
  { province: '安徽省', city: '亳州市', district: '谯城区' },
  { province: '安徽省', city: '池州市', district: '贵池区' },
  { province: '安徽省', city: '宣城市', district: '宣州区' },
  { province: '福建省', city: '福州市', district: '鼓楼区' },
  { province: '福建省', city: '厦门市', district: '思明区' },
  { province: '福建省', city: '莆田市', district: '城厢区' },
  { province: '福建省', city: '三明市', district: '三元区' },
  { province: '福建省', city: '泉州市', district: '鲤城区' },
  { province: '福建省', city: '漳州市', district: '芗城区' },
  { province: '福建省', city: '南平市', district: '延平区' },
  { province: '福建省', city: '龙岩市', district: '新罗区' },
  { province: '福建省', city: '宁德市', district: '蕉城区' },
  { province: '江西省', city: '南昌市', district: '东湖区' },
  { province: '江西省', city: '景德镇市', district: '珠山区' },
  { province: '江西省', city: '萍乡市', district: '安源区' },
  { province: '江西省', city: '九江市', district: '浔阳区' },
  { province: '江西省', city: '新余市', district: '渝水区' },
  { province: '江西省', city: '鹰潭市', district: '月湖区' },
  { province: '江西省', city: '赣州市', district: '章贡区' },
  { province: '江西省', city: '吉安市', district: '吉州区' },
  { province: '江西省', city: '宜春市', district: '袁州区' },
  { province: '江西省', city: '抚州市', district: '临川区' },
  { province: '江西省', city: '上饶市', district: '信州区' },
  { province: '山东省', city: '济南市', district: '历下区' },
  { province: '山东省', city: '青岛市', district: '市南区' },
  { province: '山东省', city: '淄博市', district: '张店区' },
  { province: '山东省', city: '枣庄市', district: '市中区' },
  { province: '山东省', city: '东营市', district: '东营区' },
  { province: '山东省', city: '烟台市', district: '芝罘区' },
  { province: '山东省', city: '潍坊市', district: '奎文区' },
  { province: '山东省', city: '济宁市', district: '任城区' },
  { province: '山东省', city: '泰安市', district: '泰山区' },
  { province: '山东省', city: '威海市', district: '环翠区' },
  { province: '山东省', city: '日照市', district: '东港区' },
  { province: '山东省', city: '临沂市', district: '兰山区' },
  { province: '山东省', city: '德州市', district: '德城区' },
  { province: '山东省', city: '聊城市', district: '东昌府区' },
  { province: '山东省', city: '滨州市', district: '滨城区' },
  { province: '山东省', city: '菏泽市', district: '牡丹区' },
  { province: '河南省', city: '郑州市', district: '金水区' },
  { province: '河南省', city: '开封市', district: '龙亭区' },
  { province: '河南省', city: '洛阳市', district: '西工区' },
  { province: '河南省', city: '平顶山市', district: '新华区' },
  { province: '河南省', city: '安阳市', district: '文峰区' },
  { province: '河南省', city: '鹤壁市', district: '淇滨区' },
  { province: '河南省', city: '新乡市', district: '红旗区' },
  { province: '河南省', city: '焦作市', district: '解放区' },
  { province: '河南省', city: '濮阳市', district: '华龙区' },
  { province: '河南省', city: '许昌市', district: '魏都区' },
  { province: '河南省', city: '漯河市', district: '源汇区' },
  { province: '河南省', city: '三门峡市', district: '湖滨区' },
  { province: '河南省', city: '南阳市', district: '卧龙区' },
  { province: '河南省', city: '商丘市', district: '睢阳区' },
  { province: '河南省', city: '信阳市', district: '浉河区' },
  { province: '河南省', city: '周口市', district: '川汇区' },
  { province: '河南省', city: '驻马店市', district: '驿城区' },
  { province: '湖北省', city: '武汉市', district: '武昌区' },
  { province: '湖北省', city: '黄石市', district: '黄石港区' },
  { province: '湖北省', city: '十堰市', district: '茅箭区' },
  { province: '湖北省', city: '宜昌市', district: '西陵区' },
  { province: '湖北省', city: '襄阳市', district: '襄城区' },
  { province: '湖北省', city: '鄂州市', district: '鄂城区' },
  { province: '湖北省', city: '荆门市', district: '东宝区' },
  { province: '湖北省', city: '孝感市', district: '孝南区' },
  { province: '湖北省', city: '荆州市', district: '沙市区' },
  { province: '湖北省', city: '黄冈市', district: '黄州区' },
  { province: '湖北省', city: '咸宁市', district: '咸安区' },
  { province: '湖北省', city: '随州市', district: '曾都区' },
  { province: '湖北省', city: '恩施土家族苗族自治州', district: '恩施市' },
  { province: '湖南省', city: '长沙市', district: '岳麓区' },
  { province: '湖南省', city: '株洲市', district: '天元区' },
  { province: '湖南省', city: '湘潭市', district: '岳塘区' },
  { province: '湖南省', city: '衡阳市', district: '雁峰区' },
  { province: '湖南省', city: '邵阳市', district: '大祥区' },
  { province: '湖南省', city: '岳阳市', district: '岳阳楼区' },
  { province: '湖南省', city: '常德市', district: '武陵区' },
  { province: '湖南省', city: '张家界市', district: '永定区' },
  { province: '湖南省', city: '益阳市', district: '赫山区' },
  { province: '湖南省', city: '郴州市', district: '北湖区' },
  { province: '湖南省', city: '永州市', district: '冷水滩区' },
  { province: '湖南省', city: '怀化市', district: '鹤城区' },
  { province: '湖南省', city: '娄底市', district: '娄星区' },
  { province: '湖南省', city: '湘西土家族苗族自治州', district: '吉首市' },
  { province: '广东省', city: '广州市', district: '天河区' },
  { province: '广东省', city: '韶关市', district: '浈江区' },
  { province: '广东省', city: '深圳市', district: '南山区' },
  { province: '广东省', city: '珠海市', district: '香洲区' },
  { province: '广东省', city: '汕头市', district: '金平区' },
  { province: '广东省', city: '佛山市', district: '禅城区' },
  { province: '广东省', city: '江门市', district: '蓬江区' },
  { province: '广东省', city: '湛江市', district: '赤坎区' },
  { province: '广东省', city: '茂名市', district: '茂南区' },
  { province: '广东省', city: '肇庆市', district: '端州区' },
  { province: '广东省', city: '惠州市', district: '惠城区' },
  { province: '广东省', city: '梅州市', district: '梅江区' },
  { province: '广东省', city: '汕尾市', district: '城区' },
  { province: '广东省', city: '河源市', district: '源城区' },
  { province: '广东省', city: '阳江市', district: '江城区' },
  { province: '广东省', city: '清远市', district: '清城区' },
  { province: '广东省', city: '东莞市', district: '东莞市' },
  { province: '广东省', city: '中山市', district: '中山市' },
  { province: '广东省', city: '潮州市', district: '湘桥区' },
  { province: '广东省', city: '揭阳市', district: '榕城区' },
  { province: '广东省', city: '云浮市', district: '云城区' },
  { province: '广西壮族自治区', city: '南宁市', district: '青秀区' },
  { province: '广西壮族自治区', city: '柳州市', district: '城中区' },
  { province: '广西壮族自治区', city: '桂林市', district: '秀峰区' },
  { province: '广西壮族自治区', city: '梧州市', district: '万秀区' },
  { province: '广西壮族自治区', city: '北海市', district: '海城区' },
  { province: '广西壮族自治区', city: '防城港市', district: '港口区' },
  { province: '广西壮族自治区', city: '钦州市', district: '钦南区' },
  { province: '广西壮族自治区', city: '贵港市', district: '港北区' },
  { province: '广西壮族自治区', city: '玉林市', district: '玉州区' },
  { province: '广西壮族自治区', city: '百色市', district: '右江区' },
  { province: '广西壮族自治区', city: '贺州市', district: '八步区' },
  { province: '广西壮族自治区', city: '河池市', district: '金城江区' },
  { province: '广西壮族自治区', city: '来宾市', district: '兴宾区' },
  { province: '广西壮族自治区', city: '崇左市', district: '江州区' },
  { province: '海南省', city: '海口市', district: '龙华区' },
  { province: '海南省', city: '三亚市', district: '吉阳区' },
  { province: '海南省', city: '三沙市', district: '西沙区' },
  { province: '海南省', city: '儋州市', district: '那大镇' },
  { province: '重庆市', city: '重庆市', district: '渝中区' },
  { province: '四川省', city: '成都市', district: '武侯区' },
  { province: '四川省', city: '自贡市', district: '自流井区' },
  { province: '四川省', city: '攀枝花市', district: '东区' },
  { province: '四川省', city: '泸州市', district: '江阳区' },
  { province: '四川省', city: '德阳市', district: '旌阳区' },
  { province: '四川省', city: '绵阳市', district: '涪城区' },
  { province: '四川省', city: '广元市', district: '利州区' },
  { province: '四川省', city: '遂宁市', district: '船山区' },
  { province: '四川省', city: '内江市', district: '市中区' },
  { province: '四川省', city: '乐山市', district: '市中区' },
  { province: '四川省', city: '南充市', district: '顺庆区' },
  { province: '四川省', city: '眉山市', district: '东坡区' },
  { province: '四川省', city: '宜宾市', district: '翠屏区' },
  { province: '四川省', city: '广安市', district: '广安区' },
  { province: '四川省', city: '达州市', district: '通川区' },
  { province: '四川省', city: '雅安市', district: '雨城区' },
  { province: '四川省', city: '巴中市', district: '巴州区' },
  { province: '四川省', city: '资阳市', district: '雁江区' },
  { province: '四川省', city: '阿坝藏族羌族自治州', district: '马尔康市' },
  { province: '四川省', city: '甘孜藏族自治州', district: '康定市' },
  { province: '四川省', city: '凉山彝族自治州', district: '西昌市' },
  { province: '贵州省', city: '贵阳市', district: '云岩区' },
  { province: '贵州省', city: '六盘水市', district: '钟山区' },
  { province: '贵州省', city: '遵义市', district: '红花岗区' },
  { province: '贵州省', city: '安顺市', district: '西秀区' },
  { province: '贵州省', city: '毕节市', district: '七星关区' },
  { province: '贵州省', city: '铜仁市', district: '碧江区' },
  { province: '贵州省', city: '黔西南布依族苗族自治州', district: '兴义市' },
  { province: '贵州省', city: '黔东南苗族侗族自治州', district: '凯里市' },
  { province: '贵州省', city: '黔南布依族苗族自治州', district: '都匀市' },
  { province: '云南省', city: '昆明市', district: '官渡区' },
  { province: '云南省', city: '曲靖市', district: '麒麟区' },
  { province: '云南省', city: '玉溪市', district: '红塔区' },
  { province: '云南省', city: '保山市', district: '隆阳区' },
  { province: '云南省', city: '昭通市', district: '昭阳区' },
  { province: '云南省', city: '丽江市', district: '古城区' },
  { province: '云南省', city: '普洱市', district: '思茅区' },
  { province: '云南省', city: '临沧市', district: '临翔区' },
  { province: '云南省', city: '楚雄彝族自治州', district: '楚雄市' },
  { province: '云南省', city: '红河哈尼族彝族自治州', district: '蒙自市' },
  { province: '云南省', city: '文山壮族苗族自治州', district: '文山市' },
  { province: '云南省', city: '西双版纳傣族自治州', district: '景洪市' },
  { province: '云南省', city: '大理白族自治州', district: '大理市' },
  { province: '云南省', city: '德宏傣族景颇族自治州', district: '芒市' },
  { province: '云南省', city: '怒江傈僳族自治州', district: '泸水市' },
  { province: '云南省', city: '迪庆藏族自治州', district: '香格里拉市' },
  { province: '西藏自治区', city: '拉萨市', district: '城关区' },
  { province: '西藏自治区', city: '日喀则市', district: '桑珠孜区' },
  { province: '西藏自治区', city: '昌都市', district: '卡若区' },
  { province: '西藏自治区', city: '林芝市', district: '巴宜区' },
  { province: '西藏自治区', city: '山南市', district: '乃东区' },
  { province: '西藏自治区', city: '那曲市', district: '色尼区' },
  { province: '西藏自治区', city: '阿里地区', district: '噶尔县' },
  { province: '陕西省', city: '西安市', district: '雁塔区' },
  { province: '陕西省', city: '铜川市', district: '王益区' },
  { province: '陕西省', city: '宝鸡市', district: '金台区' },
  { province: '陕西省', city: '咸阳市', district: '秦都区' },
  { province: '陕西省', city: '渭南市', district: '临渭区' },
  { province: '陕西省', city: '延安市', district: '宝塔区' },
  { province: '陕西省', city: '汉中市', district: '汉台区' },
  { province: '陕西省', city: '榆林市', district: '榆阳区' },
  { province: '陕西省', city: '安康市', district: '汉滨区' },
  { province: '陕西省', city: '商洛市', district: '商州区' },
  { province: '甘肃省', city: '兰州市', district: '城关区' },
  { province: '甘肃省', city: '嘉峪关市', district: '雄关区' },
  { province: '甘肃省', city: '金昌市', district: '金川区' },
  { province: '甘肃省', city: '白银市', district: '白银区' },
  { province: '甘肃省', city: '天水市', district: '秦州区' },
  { province: '甘肃省', city: '武威市', district: '凉州区' },
  { province: '甘肃省', city: '张掖市', district: '甘州区' },
  { province: '甘肃省', city: '平凉市', district: '崆峒区' },
  { province: '甘肃省', city: '酒泉市', district: '肃州区' },
  { province: '甘肃省', city: '庆阳市', district: '西峰区' },
  { province: '甘肃省', city: '定西市', district: '安定区' },
  { province: '甘肃省', city: '陇南市', district: '武都区' },
  { province: '甘肃省', city: '临夏回族自治州', district: '临夏市' },
  { province: '甘肃省', city: '甘南藏族自治州', district: '合作市' },
  { province: '青海省', city: '西宁市', district: '城中区' },
  { province: '青海省', city: '海东市', district: '乐都区' },
  { province: '宁夏回族自治区', city: '银川市', district: '兴庆区' },
  { province: '宁夏回族自治区', city: '石嘴山市', district: '大武口区' },
  { province: '宁夏回族自治区', city: '吴忠市', district: '利通区' },
  { province: '宁夏回族自治区', city: '固原市', district: '原州区' },
  { province: '宁夏回族自治区', city: '中卫市', district: '沙坡头区' },
  { province: '新疆维吾尔自治区', city: '乌鲁木齐市', district: '天山区' },
  { province: '新疆维吾尔自治区', city: '克拉玛依市', district: '克拉玛依区' },
  { province: '新疆维吾尔自治区', city: '吐鲁番市', district: '高昌区' },
  { province: '新疆维吾尔自治区', city: '哈密市', district: '伊州区' },
  { province: '新疆维吾尔自治区', city: '昌吉回族自治州', district: '昌吉市' },
  { province: '新疆维吾尔自治区', city: '博尔塔拉蒙古自治州', district: '博乐市' },
  { province: '新疆维吾尔自治区', city: '巴音郭楞蒙古自治州', district: '库尔勒市' },
  { province: '新疆维吾尔自治区', city: '阿克苏地区', district: '阿克苏市' },
  { province: '新疆维吾尔自治区', city: '克孜勒苏柯尔克孜自治州', district: '阿图什市' },
  { province: '新疆维吾尔自治区', city: '喀什地区', district: '喀什市' },
  { province: '新疆维吾尔自治区', city: '和田地区', district: '和田市' },
  { province: '新疆维吾尔自治区', city: '伊犁哈萨克自治州', district: '伊宁市' },
  { province: '新疆维吾尔自治区', city: '塔城地区', district: '塔城市' },
  { province: '新疆维吾尔自治区', city: '阿勒泰地区', district: '阿勒泰市' }
] as const satisfies readonly BillingRegion[]

/** 至少 100 组短道路名称；门牌号在生成时随机补充。 */
export const BILLING_STREET_NAMES = [
  '新福路', '幸福路', '兴业路', '永安路', '兴华路', '新华路', '光明路', '解放路',
  '和平路', '建设路', '文昌路', '富民路', '长安路', '青年路', '人民路', '中山路',
  '文化路', '学府路', '环城路', '胜利路', '友谊路', '团结路', '迎宾路', '南山路',
  '北山路', '东湖路', '西湖路', '江滨路', '滨江路', '临江路', '朝阳路', '曙光路',
  '春风路', '春华路', '春晖路', '秋实路', '金山路', '银山路', '玉泉路', '清泉路',
  '青云路', '青松路', '翠竹路', '红星路', '红旗路', '彩虹路', '星光路', '月明路',
  '天成路', '天和路', '天宁路', '安宁路', '安康路', '安居路', '康乐路', '康宁路',
  '福安路', '福星路', '福运路', '德胜路', '德兴路', '仁和路', '仁爱路', '同心路',
  '同德路', '同安路', '致远路', '远大路', '宏达路', '宏图路', '华兴路', '华安路',
  '华新路', '泰安路', '泰和路', '盛世路', '盛华路', '锦绣路', '锦程路', '金龙路',
  '银杏路', '梧桐路', '松柏路', '竹园路', '梅园路', '兰园路', '荷花路', '莲花路',
  '桃园路', '桂花路', '牡丹路', '紫薇路', '龙湖路', '凤山路', '麒麟路', '长虹路',
  '飞虹路', '云山路', '云海路', '海棠路', '湖滨路', '滨湖路', '软件园路', '科技路',
  '创新路', '创业路', '发展路', '开放路', '未来路', '幸福大道', '滨江大道', '解放大道'
] as const

function randomNumber(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function shuffle<T>(items: readonly T[]): T[] {
  const result = [...items]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    ;[result[index], result[swapIndex]] = [result[swapIndex], result[index]]
  }
  return result
}

let regionPool: BillingRegion[] = []
let streetPool: string[] = []
let lastRegion: BillingRegion | undefined
let lastStreet: string | undefined

function nextFromPool<T>(source: readonly T[], pool: T[], previous: T | undefined): T {
  if (pool.length === 0) {
    pool.push(...shuffle(source))
    if (pool.length > 1 && previous !== undefined && Object.is(pool[pool.length - 1], previous)) {
      const swapIndex = pool.length - 2
      ;[pool[swapIndex], pool[pool.length - 1]] = [pool[pool.length - 1], pool[swapIndex]]
    }
  }
  return pool.pop() as T
}

function titleCase(value: string): string {
  return value ? `${value.slice(0, 1).toUpperCase()}${value.slice(1).toLowerCase()}` : ''
}

function romanize(value: string): string {
  return pinyin(value, { toneType: 'none', type: 'array' })
    .join('')
    .replace(/[^a-zA-Z]/g, '')
}

/** 将中文道路/行政区名称转换为“主体连写、后缀独立成词”的拼音格式。 */
export function billingPinyin(value: string): string {
  const clean = value.trim().replace(/[，,；;、]/g, ' ')
  if (!clean) return ''
  const pieces = clean.match(/[\u4e00-\u9fff]+|\d+|[A-Za-z]+/g) ?? []
  const suffixes = ['特别行政区', '自治区', '自治州', '自治县', '地区', '盟', '省', '市', '区', '县', '路', '街', '道', '巷', '号']
  const words: string[] = []
  for (const piece of pieces) {
    if (/^\d+$/.test(piece)) {
      words.push(piece)
      continue
    }
    if (/^[A-Za-z]+$/.test(piece)) {
      words.push(titleCase(piece))
      continue
    }
    let remaining = piece
    const trailing: string[] = []
    while (remaining) {
      const suffix = suffixes.find((candidate) => remaining.endsWith(candidate))
      if (!suffix) break
      remaining = remaining.slice(0, -suffix.length)
      trailing.unshift(suffix)
    }
    if (remaining) words.push(titleCase(romanize(remaining)))
    for (const suffix of trailing) words.push(titleCase(romanize(suffix)))
  }
  return words.filter(Boolean).join(' ')
}

export function createLocalBillingAddress(): LocalBillingAddress {
  const region = nextFromPool(BILLING_REGIONS, regionPool, lastRegion)
  const road = nextFromPool(BILLING_STREET_NAMES, streetPool, lastStreet)
  lastRegion = region
  lastStreet = road
  const addressLine1 = billingPinyin(`${road}${randomNumber(1, 999)}号`)
  const postalCode = String(randomNumber(100000, 999999))
  if (!/^\d{6}$/.test(postalCode)) throw new Error('本地账单邮编生成失败')
  return {
    ...region,
    pinyinCity: billingPinyin(region.city),
    pinyinDistrict: billingPinyin(region.district),
    addressLine1,
    postalCode
  }
}
