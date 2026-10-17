// What each run makes. LD Cotton Mills styles only — never VHAGAR (user, 17 Oct 2026).
export const configs = {
  // An order on a style that already has its item, BOM and routing: for trying the requisition steps.
  bexley: {
    styleCode: 'LD-SH-2604', styleName: 'Bexley Stripe Shirt', colour: 'Grey Stripe',
    itemName: 'Bexley Stripe Shirt — Grey Stripe', subCategory: 'Shirts', hsn: '6205', garment: 'shirt',
    bom: [],
    trimsFromStore: ['LBL-MAIN-001', 'BTN-PLY-001', 'PKG-POLY-001'],
    customer: 'Kanha Apparels Pvt Ltd', customerSearch: 'Kanha', buyerRef: 'KA/ENQ/2640', buyerPo: 'KA/PO/7802',
    sizes: [['S', 5], ['M', 10], ['L', 10], ['XL', 5]],
    pos: [],
  },
  show: {
    styleCode: 'LD-TR-2602', styleName: 'Kingsley Twill Chino', colour: 'Khaki',
    itemName: 'Kingsley Twill Chino — Khaki', subCategory: 'Trousers', hsn: '6203', garment: 'chino',
    bom: [
      ['FAB-COT-004', 'Cutting', '1.3', '178'],
      ['TRM-INT-001', 'Fusing', '0.1', '38'],
      ['TRM-ZIP-001', 'Stitching', '1', '8.50'],
      ['LBL-MAIN-001', 'Stitching', '1', '1.85'],
      ['BTN-PLY-002', 'Kaj Button', '2', '0.65'],
      ['PKG-POLY-002', 'Packing', '1', '1.45'],
    ],
    trimsFromStore: ['TRM-ZIP-001', 'LBL-MAIN-001', 'BTN-PLY-002', 'PKG-POLY-002'],
    customer: 'Metro Menswear Wholesale', customerSearch: 'Metro', buyerRef: 'MMW/ENQ/1408', buyerPo: 'MMW/PO/4420',
    sizes: [['30', 10], ['32', 20], ['34', 20], ['36', 10]],
    pos: [
      { supplier: 'Sanskar Textiles Trading', search: 'Sanskar', location: 'Fabric Warehouse', challan: 'SAN/DC/1140', lot: 'LOT-KH-02', lines: [['Cotton Twill 2/60s — Beige', 80, 178, 2]] },
      { supplier: 'Nova Trims & Interlining', search: 'Nova', location: 'Store', challan: 'NOVA/DC/0470', lot: '', lines: [['Fusible Interlining 40 gsm', 6, 38, 1], ['Nylon Zipper 6" — Grey', 60, 8.5, 1], ['Woven Main Label — LD Cotton Mills', 60, 1.85, 1], ['Polyester Button 18L — Navy', 120, 0.65, 1], ['Poly Bag 12x16 Self Seal', 60, 1.45, 1]] },
    ],
    fabricGiven: '78', fabricUsed: '77', waste: '1', layers: '10',
    routingName: 'Kingsley Chino — trouser, stitching outside',
    unit: 'Ambika Stitching Unit', unitChallan: 'AMB/DC/3415', unitBill: 'AMB/INV/2318',
  },
}
