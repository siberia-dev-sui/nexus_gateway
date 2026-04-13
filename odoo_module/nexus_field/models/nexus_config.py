from odoo import models, fields


class NexusConfig(models.Model):
    _name = 'nexus.config'
    _description = 'Configuración NEXUS Gateway'

    name = fields.Char(default='NEXUS Gateway', readonly=True)
    gateway_url = fields.Char(
        string='URL del Gateway',
        required=True,
        default='https://77-42-71-221.sslip.io',
        help='URL base del NEXUS API Gateway'
    )
    refresh_interval = fields.Integer(
        string='Intervalo de actualización (seg)',
        default=30,
        help='Cada cuántos segundos se refresca el mapa'
    )
    supervisor_token = fields.Char(
        string='Token Supervisor',
        required=True,
        help='JWT de un usuario supervisor del gateway'
    )
