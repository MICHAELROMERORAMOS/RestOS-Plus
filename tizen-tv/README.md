# RestOS+ TV — Samsung Tizen

Aplicación dedicada para Samsung Smart TV. Al ejecutarse abre directamente `https://www.restosplus.com/pantalla-tv?tvapp=samsung`.

- Sin sesión: RestOS+ muestra su login.
- Con sesión válida: entra directamente a Estado de pedidos.
- La sesión y los datos siguen siendo los mismos de RestOS+ / Supabase.
- El TV requiere acceso a Internet.

## Empaquetado

Samsung TV requiere un paquete Web Tizen `.wgt` firmado con un certificado Samsung válido que incluya el DUID del TV.

1. Instalar Tizen Studio + Samsung TV Extension + Samsung Certificate Extension.
2. Activar Developer Mode en el TV.
3. Crear un Certificate Profile Samsung e incluir el DUID del TV.
4. Desde esta carpeta ejecutar:
   `tizen build-web -- .`
5. Firmar/empaquetar:
   `tizen package -t wgt -s <PERFIL_CERTIFICADO> -- .buildResult`
6. Conectar por SDB e instalar el `.wgt`.

No se puede instalar un WGT de desarrollo por USB en un Samsung TV de consumo.
