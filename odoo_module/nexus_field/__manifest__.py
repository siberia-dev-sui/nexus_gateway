{
    'name': 'NEXUS Field — Fuerza de Ventas',
    'version': '1.0.0',
    'category': 'Sales',
    'summary': 'Mapa en tiempo real de vendedores de campo NEXUS',
    'description': 'Visualiza la ubicación de los 120 vendedores en tiempo real directamente desde Odoo.',
    'author': 'Grupo Leiros',
    'depends': ['base', 'web'],
    'data': [
        'views/nexus_menu.xml',
        'views/nexus_map_view.xml',
    ],
    'assets': {
        'web.assets_backend': [
            'nexus_field/static/src/js/nexus_map.js',
        ],
    },
    'installable': True,
    'application': True,
    'license': 'LGPL-3',
}
