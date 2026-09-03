/** Catálogos Compaq i — códigos, RFC y límites tal cual el maestro. Sin importes de cartera. */

export const UOM_CATALOG = [
  { code: "TM", name: "Tonelada métrica" },
  { code: "KGS", name: "Kilogramos" },
  { code: "LTS", name: "Litros" },
  { code: "ROLLOS", name: "Rollos" },
  { code: "PZAS", name: "Piezas" },
];

export const PRODUCT_KIND_CATALOG = [
  { code: "AGROQUIMICOS", name: "Agroquímicos" },
  { code: "FERTILIZANTES", name: "Fertilizantes" },
  { code: "INSUMO", name: "Insumos" },
  { code: "MAQUINARIA", name: "Maquinaria" },
  { code: "SOLUBLE", name: "Soluble" },
  { code: "GRANULADO", name: "Granulado" },
  { code: "LIQUIDO", name: "Líquido" },
];

export const PARTNER_GROUP_CATALOG = [
  { code: "GRUPO_SL", name: "Grupo SL" },
  { code: "VARIOS", name: "Varios" },
  { code: "FERTISEM", name: "Fertisem" },
  { code: "STA_ROSA", name: "Santa Rosa" },
];

// Etiquetas de la política de cobro del pedido. Solo son un nombre: la mora
// real siempre se calcula con la TIIE de la tabla + spread y comisión + FEGA de
// Ajustes. Por eso aquí no van números.
export const CREDIT_POLICY_CATALOG = [
  { code: "NONE", name: "Sin mora" },
  { code: "GRUPO_SL", name: "Grupo SL — TIIE del vencimiento + spread y comisión + FEGA de Ajustes" },
  { code: "ESTANDAR", name: "Estándar — TIIE del vencimiento + spread de Ajustes" },
];

export const BANK_CATALOG = [
  { name: "Banorte MXN", account: "", currency: "MXN" },
  { name: "Banorte USD", account: "", currency: "USD" },
];

export const EXPENSE_CATALOG: Array<{ code: string; name: string; class: "operativo" | "pedido" | "financiero" }> = [
  { code: "GASOLINA", name: "Gasolina / diésel", class: "operativo" },
  { code: "OFICINA", name: "Oficina y papelería", class: "operativo" },
  { code: "SUELDOS", name: "Sueldos y nómina", class: "operativo" },
  { code: "FLETES", name: "Fletes generales", class: "operativo" },
  { code: "VIATICOS", name: "Viáticos", class: "operativo" },
  { code: "MANTTO", name: "Mantenimiento", class: "operativo" },
  { code: "RENTA", name: "Renta", class: "operativo" },
  { code: "SERVICIOS", name: "Servicios (luz, agua, tel)", class: "operativo" },
  { code: "SEGUROS", name: "Seguros", class: "operativo" },
  { code: "FLETE_PED", name: "Flete de pedido", class: "pedido" },
  { code: "DESCARGA", name: "Descarga / maniobras", class: "pedido" },
  { code: "INSPECCION", name: "Inspección", class: "pedido" },
  { code: "ACOMODO", name: "Acomodo en campo", class: "pedido" },
  { code: "INTERESES", name: "Intereses pagados", class: "financiero" },
  { code: "COMISION", name: "Comisión bancaria", class: "financiero" },
  { code: "DIF_FX", name: "Diferencial cambiario", class: "financiero" },
  { code: "FEGA", name: "FEGA", class: "financiero" },
  { code: "TIIE", name: "TIIE / costo financiero", class: "financiero" },
];

/** TIIE 28 días mensual (de la hoja TIIE_HISTORICA). */
export const TIIE_SEED: Array<[string, number]> = [
  ["2025-01-01", 0.1075],
  ["2025-02-01", 0.103],
  ["2025-03-01", 0.1005],
  ["2025-04-01", 0.0955],
  ["2025-05-01", 0.093],
  ["2025-06-01", 0.0905],
  ["2025-07-01", 0.088],
  ["2025-08-01", 0.0855],
  ["2025-09-01", 0.0832],
  ["2025-10-01", 0.0815],
  ["2025-11-01", 0.0795],
  ["2025-12-01", 0.0775],
  ["2026-01-01", 0.076],
  ["2026-02-01", 0.076],
  ["2026-03-01", 0.074],
  ["2026-04-01", 0.073],
  ["2026-05-01", 0.0706],
];

export type PartnerSeed = {
  code: string;
  name: string;
  legal_name: string;
  rfc: string;
  is_customer: boolean;
  is_supplier: boolean;
  group_name: string;
  city: string;
  payment_days: number;
  partner_kind: string;
  credit_limit: number;
};

function cli(
  code: string,
  name: string,
  rfc: string,
  credit_limit: number,
  group_name = "Varios",
  payment_days = 0,
): PartnerSeed {
  return {
    code,
    name,
    legal_name: name,
    rfc,
    is_customer: true,
    is_supplier: false,
    group_name,
    city: "",
    payment_days,
    partner_kind: "trade",
    credit_limit,
  };
}

function prv(code: string, name: string, rfc: string, group_name = "Varios", partner_kind = "vendor"): PartnerSeed {
  return {
    code,
    name,
    legal_name: name,
    rfc,
    is_customer: false,
    is_supplier: true,
    group_name,
    city: "",
    payment_days: 0,
    partner_kind,
    credit_limit: 0,
  };
}

/** Maestro Compaq: Clientes CL0001–CL0034 + Proveedores PV001–PV017. */
export const PARTNER_CATALOG: PartnerSeed[] = [
  cli("CL0001", "SEMILLAS FERTILIZANTES Y SERVICIOS", "SFS090715KG3", 0),
  cli("CL0002", "AGRICOLA .29", "AGR230224F49", 0),
  cli("CL0003", "AGRICOLA .29", "AGR230224F49", 0),
  cli("CL0004", "ALMACENES Y SERVICIOS SANTA ROSA", "ASS040209GR3", 0, "Santa Rosa"),
  cli("CL0005", "EL CEMPOAL", "CPR960101354", 500000),
  cli("CL0006", "FERTISEM DEL PACIFICO", "FPA231020EI4", 0, "Fertisem"),
  cli("CL0007", "AGRICOLA SIRFRAND", "ASI210928212", 1000000),
  cli("CL0008", "PRODUCTORA DE PAPAS RANCHO GALVEZ", "PPR120906EG4", 1500000),
  cli("CL0009", "HMF AGRICOLA", "HAG020314GJ4", 0),
  cli("CL0010", "JOSE ALBERTO MIRANDA BOJORQUEZ", "MIBA9608309N2", 0),
  cli("CL0011", "PUBLICO EN GENERAL.", "XAXX010101000", 0),
  cli("CL0012", "AGRICOLA CHARLY", "ACA070215JW7", 0),
  cli("CL0013", "AGRICOLA COTA Y COTA", "ACC9304149I1", 0),
  cli("CL0014", "SANTA ROSA AGRONEGOCIOS", "SRA160524348", 0, "Santa Rosa"),
  cli("CL0015", "ALMA PATRICIA FIGUEROA LOPEZ", "FILA860109PJ3", 0),
  cli("CL0016", "AGRICOLA DYRENE", "ADY060810C1A", 0),
  cli("CL0017", "CANES AGRICOLA", "CAG190925UN0", 0),
  cli("CL0018", "SL AGRICOLA", "SAG070818I39", 25000000, "Grupo SL", 150),
  cli("CL0019", "COMERCIALIZADORA DE LEGUMBRES CACO", "CLC131003CB3", 25000000, "Grupo SL", 150),
  cli("CL0020", "COMERCIALIZADORA DE LEGUMBRES DE LOS MOCHIS CAT", "CLM0910276C8", 25000000, "Grupo SL", 150),
  cli("CL0021", "ERY AGROINSUMOS", "EAG170829HA6", 0),
  cli("CL0022", "PRODUCTOS AGRICHARCOS", "PAG1103035VA", 0),
  cli("CL0023", "JOSE ABRAHAM GONZALEZ GASTELUM", "GOGA721222GN7", 0),
  cli("CL0024", "AGRICOLA VANTA", "AVA2107163M7", 0),
  cli("CL0025", "AGRICOLA POTATO", "APO240531HX9", 0),
  cli("CL0026", "AGRICOLA PREMIER", "APR970903LE2", 0),
  cli("CL0027", "SISTEMAS DE PRODUCCION INTENSIVA DEL NOROESTE", "SPI0411291LA", 0),
  cli("CL0028", "RAM FARMS", "RFA160912D76", 0),
  cli("CL0029", "ESTEBAN CARLOS AGUIRRE ZAZUETA", "AUZE900405BW3", 0),
  cli("CL0030", "AGROGATO", "AGR140303FX2", 0),
  cli("CL0031", "AGRICOLA LOS LAURELES DE LA ONCE", "ALO22021751A", 0),
  cli("CL0032", "JESUS MARIO RODRIGUEZ ASTORGA", "ROAJ941023EV9", 0),
  cli("CL0033", "AGRICOLA BERSE", "ABE011201M84", 0),
  cli("CL0034", "GRANELERA JANOS", "GJA170407BI9", 0),
  prv("PV001", "FERTILIZANTES TEPEYAC SA DE CV", ""),
  prv("PV002", "FERTISEM DEL PACIFICO", "", "Fertisem"),
  prv("PV003", "SERVICIOS Y FERTILIZANTES DEL NOROESTE", "SFN0009197W2"),
  prv("PV004", "EUROCHEM AGRO MEXICO", "EAM030716PW9"),
  prv("PV005", "AARFS", "AAR990427Q6A"),
  prv("PV006", "PACIFEX", "PAC930423RB7"),
  prv("PV007", "GRUPO IMPULSORA", "GCE020822UM2"),
  prv("PV008", "POLAQUIMIA", "POL800918NC6"),
  prv("PV009", "CASTELO CASTILLO ARMANDO JAVIER", "CACX5912035H1"),
  prv("PV010", "AGRO FAAS", "AFA1705276C4"),
  prv("PV011", "VALSIMEX SA DE CV", "VEL880624879"),
  prv("PV012", "AGROINSUMOS DEL CAMPO SA DE CV", "ACA070903K59"),
  prv("PV013", "COMERCIALIZADORA GREENHOW", "CGR060705NS2"),
  prv("PV014", "COMERCIALIZADORA  GAYA", "CGA060524E41"),
  prv("PV015", "ALMACENES Y SERVICIOS SANTA ROSA", "ASS040206GR3", "Santa Rosa", "finance"),
  prv("PV016", "AGROSANIDAD", "AGR050923CT7"),
  prv("PV017", "CESAR JOEL RAMIREZ RUSSELL", "RARC630801DLA"),
];

export type ProductSeed = {
  code: string;
  name: string;
  product_type: string;
  uom: string;
  list_price: number;
  iva: number;
};

function prod(code: string, name: string, product_type: string, uom: string, list_price = 0, iva = 0): ProductSeed {
  return { code, name, product_type, uom, list_price, iva };
}

/** Maestro Compaq: Productos — código, nombre, clasificación y precio 1. */
export const PRODUCT_CATALOG: ProductSeed[] = [
  prod("ALB01", "COFACTOR", "AGROQUIMICOS", "LTS"),
  prod("ALB02", "ADHERES X 12X1", "AGROQUIMICOS", "LTS"),
  prod("ALB03", "AGRIFOL 20-0-10 1LTR", "AGROQUIMICOS", "LTS"),
  prod("ALB04", "AGRIFOL 20-30-10 20LTR", "AGROQUIMICOS", "LTS"),
  prod("ALB05", "EXTERMINATOR 1LTR", "AGROQUIMICOS", "LTS"),
  prod("ALB06", "EXTERMINATOR PLUS 1 LTR", "AGROQUIMICOS", "LTS"),
  prod("ALB07", "AGRI-KELP 1 LTR", "AGROQUIMICOS", "LTS"),
  prod("ALB08", "AGRIMIN BMO 20 LTR", "AGROQUIMICOS", "LTS"),
  prod("ALB09", "ADHERES PLUS 12X1", "AGROQUIMICOS", "LTS"),
  prod("ALB10", "MIX PROTECTIVEE CL 1X20", "AGROQUIMICOS", "LTS", 312.02),
  prod("ALB11", "MIX PROTECTIVEE O 1X20", "AGROQUIMICOS", "LTS", 312.02),
  prod("ALB12", "MIX PROTECTIVEE M 1X20", "AGROQUIMICOS", "LTS"),
  prod("ALI01", "BRAVIO", "AGROQUIMICOS", "LTS"),
  prod("ALI02", "JASPE", "AGROQUIMICOS", "LTS"),
  prod("ALI03", "CYPERVEL 200", "AGROQUIMICOS", "LTS"),
  prod("ALI04", "CYPERVEL IMPETOR 200", "AGROQUIMICOS", "LTS"),
  prod("ALN01", "FERTIPOL POLI 8-30-0", "AGROQUIMICOS", "KGS"),
  prod("ALN02", "FERTIPOL ZINC 5 L", "AGROQUIMICOS", "LTS"),
  prod("FGCOME1", "ENTEC 12-12-17", "FERTILIZANTES", "KGS"),
  prod("FGCOMN4", "NITROFOSKA 20-10-10", "FERTILIZANTES", "KGS"),
  prod("FGCOMN5", "NITROFOSKA SPECIAL 12 12 17", "FERTILIZANTES", "KGS"),
  prod("FGCOMT16", "TRIPLE 16", "FERTILIZANTES", "KGS"),
  prod("FGFDA1", "DAP 18-46-0", "FERTILIZANTES", "KGS"),
  prod("FGFMA1", "MAP 11-52-0", "FERTILIZANTES", "KGS"),
  prod("FGMF1", "MEZCLA FISICA 14-15-15.5+11S", "FERTILIZANTES", "KGS"),
  prod("FGMF10", "MEZCLAA 30-12-0+8S ENV", "FERTILIZANTES", "KGS"),
  prod("FGMF3", "MEZCLA 33-5-5+4S+ MICROS", "FERTILIZANTES", "KGS"),
  prod("FGMF4", "MEZCLA 17-15-15+8S+0.5MG+0.16MN+0.9ZN+0.14FE+0.05BO", "FERTILIZANTES", "KGS"),
  prod("FGMF5", "MEZCLA 11-13-14-3S-1MG-1ZN-0.21BO", "FERTILIZANTES", "KGS"),
  prod("FGMF6", "MEZCLA 14-12-13+12S+2.7MG+0.25Bo+HUMIFLEX", "FERTILIZANTES", "KGS"),
  prod("FGMF7", "MEZCLAS SOLIDAS", "FERTILIZANTES", "KGS"),
  prod("FGMF8", "MF 400 SAM + 100 MAP", "FERTILIZANTES", "KGS"),
  prod("FGMF9", "MEZCLA 14-13-13+11S+3Mg+0.23Bo+MICROS", "FERTILIZANTES", "KGS"),
  prod("FGNFOS1", "FOSFONITRATO ENVASADO 50 KG", "FERTILIZANTES", "KGS"),
  prod("FGNFOS2", "FOSFONITRATO SACO 25 KG", "FERTILIZANTES", "KGS"),
  prod("FGNFOS3", "FOSFONITRATO SACO 50 KG", "FERTILIZANTES", "KGS"),
  prod("FGNFOS4", "FOSFONITRATO SACO 25 KGS", "FERTILIZANTES", "KGS"),
  prod("FGNSAE2", "SULFATO DE AMONIO ESTANDAR 25 KG", "FERTILIZANTES", "KGS"),
  prod("FGNSAG1", "SULFATO DE AMONIO GRANULAR", "FERTILIZANTES", "KGS"),
  prod("FGNURG1", "UREA GRANULAR ENVASADO 50KGS", "FERTILIZANTES", "KGS"),
  prod("FGNURG2", "UREA GRANULAR ENVASADO 25KGS", "FERTILIZANTES", "KGS"),
  prod("FGNURG3", "UREA GRANULAR GRANEL", "FERTILIZANTES", "TM"),
  prod("FGPSPG1", "SULFATO DE POTASIO ENVASADO 50 KGS", "FERTILIZANTES", "KGS"),
  prod("FLAFOS", "ACIDO FOSFORICO", "FERTILIZANTES", "LTS"),
  prod("FLAFOST", "ACIDO FOSFORICO TOTEM", "FERTILIZANTES", "LTS"),
  prod("FMSABOR", "ACIDO BORICO", "FERTILIZANTES", "KGS"),
  prod("FMSANIT", "ACIDO NITRICO", "FERTILIZANTES", "LTS"),
  prod("FMSASUL", "ACIDO SULFURICO", "FERTILIZANTES", "LTS"),
  prod("FMSCOB", "SULFATO DE COBRE PENTAHIDRATADO F-100 ENV 25 KGS", "FERTILIZANTES", "KGS"),
  prod("FMSFIERRO", "SULFATO DE FIERRO", "FERTILIZANTES", "KGS"),
  prod("FMSMIX", "COLOSSAL MICROHOW FULL MIX B", "FERTILIZANTES", "KGS"),
  prod("FMSMOBDA", "MOLIBDATO DE AMONIO", "FERTILIZANTES", "KGS"),
  prod("FMSMOBSO", "MOLIBDATO DE SODIO", "FERTILIZANTES", "KGS"),
  prod("FMSPROZN", "PRO ZINC PLUS", "FERTILIZANTES", "KGS"),
  prod("FMSQCU", "QUELATO DE COBRE", "FERTILIZANTES", "KGS"),
  prod("FMSQFE", "EDDHA FE 6%", "FERTILIZANTES", "KGS"),
  prod("FMSQFE2", "QUELATO FIERRO 13%", "FERTILIZANTES", "KGS"),
  prod("FMSQMN", "QUELATO DE MANGANESO", "FERTILIZANTES", "KGS"),
  prod("FMSQZN", "QUELATO ZINC", "FERTILIZANTES", "KGS"),
  prod("FMSZINC", "SULFATO DE ZINC", "FERTILIZANTES", "KGS"),
  prod("FSAK44", "AK 44 UREA FOSFATO", "FERTILIZANTES", "KGS"),
  prod("FSBORO", "MICROHOW BORO", "FERTILIZANTES", "KGS"),
  prod("FSCCAL", "CLORURO DE CALCIO", "FERTILIZANTES", "KGS"),
  prod("FSCN6", "15-30-15 (KCL)", "FERTILIZANTES", "KGS"),
  prod("FSKCL", "CLORURO DE POTASIO SOLUBLE", "FERTILIZANTES", "KGS"),
  prod("FSMAG", "SULFATO DE MAGNESIO ENV 25 KGS", "FERTILIZANTES", "KGS"),
  prod("FSMAP", "MAP 12-61-0", "FERTILIZANTES", "KGS", 1),
  prod("FSMKP", "FOSFATO MONOPOTASICO MKP", "FERTILIZANTES", "KGS"),
  prod("FSNKS", "NITRATO DE POTASIO SOLUBLE", "FERTILIZANTES", "KGS"),
  prod("FSNMG", "NITRATO DE MAGNESIO", "FERTILIZANTES", "KGS"),
  prod("FSNNC", "NITRATO DE CALCIO", "FERTILIZANTES", "KGS"),
  prod("FSSAZU1", "AZUFRE SOLUBLE", "FERTILIZANTES", "KGS"),
  prod("FSSMAN1", "SULFATO DE MANGANESO", "FERTILIZANTES", "KGS"),
  prod("FSSOP", "SULFATO DE POTASIO ENV 25 KGS", "FERTILIZANTES", "KGS"),
  prod("FST18", "TRIPLE 18", "FERTILIZANTES", "KGS"),
  prod("FSYESO", "YESO AGRICOLA (SACO 50 KG)", "FERTILIZANTES", "KGS"),
  prod("IMR01", "CINTA AQUATRAXX 5/8 CAL 8000 DE 0.5 A 15 CMS", "INSUMO", "ROLLOS"),
  prod("IMR02", "CINTA AQUATRAXX 5/8 CAL 6000 DE 0.5 A 15 CMS", "INSUMO", "ROLLOS"),
  prod("IMR03", "SISTEMA DE RIEGO POR GOTEO AZUL 5/8ID 05MIL 06.20GPH", "INSUMO", "ROLLOS"),
  prod("IMR04", "SISTEMA DE RIEGO POR GOTEO AZUL 5/8ID 05MIL 06 .13GPH 13000F", "INSUMO", "ROLLOS"),
  prod("MEB01", "TRANSPORTADOR DE BANDA PLANO CON COSEDORA DE PEDESTAL", "MAQUINARIA", "PZAS", 0, 16),
  prod("MGMF9", "MF UREA2 + SAM1", "FERTILIZANTES", "KGS"),
];

export type LocationSeed = {
  code: string;
  name: string;
  loc_type: "internal" | "supplier" | "transit";
  partnerCode?: string;
};

/** Maestro Compaq: Almacenes — código y nombre tal cual. */
export const LOCATION_CATALOG: LocationSeed[] = [
  { code: "001", name: "Almacen Quimagro-Azagro LM", loc_type: "internal" },
  { code: "002", name: "Almacen Tepeyac Topolobampo", loc_type: "supplier", partnerCode: "PV001" },
  { code: "003", name: "Almacen Seferno Mochis", loc_type: "supplier", partnerCode: "PV003" },
  { code: "004", name: "Almacen Fertisem JJ Rios", loc_type: "supplier", partnerCode: "PV002" },
  { code: "005", name: "Almacen AARFS El Globo LM", loc_type: "supplier", partnerCode: "PV005" },
  { code: "006", name: "Almacen Pacifex Mochis", loc_type: "supplier", partnerCode: "PV006" },
  { code: "007", name: "Almacen Pacifex Topolobampo", loc_type: "supplier", partnerCode: "PV006" },
  { code: "008", name: "Almacen ISAOSA Topolobampo", loc_type: "supplier" },
  { code: "009", name: "Almacen FEMSSA Topolobampo", loc_type: "supplier" },
  { code: "010", name: "Almacen FEMSSA Quimagro Mochis", loc_type: "supplier" },
  { code: "011", name: "Almacen Eurochem Agro México", loc_type: "supplier", partnerCode: "PV004" },
  { code: "012", name: "Almacen Tepeyac Mochis", loc_type: "supplier", partnerCode: "PV001" },
  { code: "013", name: "Almacen Impulsora", loc_type: "supplier", partnerCode: "PV007" },
  { code: "014", name: "Almacen AzagroStaRosa", loc_type: "internal" },
  { code: "015", name: "Almacen GreenHow Mochis", loc_type: "supplier", partnerCode: "PV013" },
  { code: "016", name: "Almacen Almacenes y Servicios Santa Rosa", loc_type: "supplier", partnerCode: "PV015" },
  { code: "1", name: "Almacen Uno", loc_type: "internal" },
  { code: "999", name: "Almacen de Mercancia en Consignacion", loc_type: "transit" },
];

export function foldName(s: string) {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}
