import type { Env, MailConfig } from './types';
import { receiveEmail } from './services/mail';
import { mailIdentities } from './config';

export async function seedLocal(env: Env, config: MailConfig): Promise<void> {
  // Called only from a loopback-only, authenticated development route.
  const present = await env.DB.prepare('SELECT id FROM mail_messages WHERE mailbox_id = ? LIMIT 1').bind(config.mailbox.id).first();
  if (present) return;
  const samples = [
    ['María Torres', 'maria@example.com', 'Propuesta para nuestro nuevo sitio web', 'Hola, equipo:\n\nEstamos buscando un equipo que nos ayude a renovar nuestra presencia digital. Nos gustaría conocer su propuesta y los siguientes pasos.\n\n¿Podemos coordinar una reunión esta semana?\n\nMuchas gracias,\nMaría'],
    ['Carlos Mendoza', 'carlos@example.com', 'Reunión de seguimiento', 'Hola, equipo:\n\nPodemos confirmar la reunión del jueves. Revisaremos los avances y los próximos pasos.\n\nSaludos,\nCarlos'],
    ['Equipo Acme', 'equipo@example.com', 'Información sobre sus servicios', 'Buenos días:\n\nNos gustaría conocer sus servicios de desarrollo web y automatización.\n\nGracias por su atención.'],
    ['Ana García', 'ana@example.com', 'Actualización del proyecto', 'Hola:\n\nYa tenemos la información necesaria para continuar con la siguiente etapa del proyecto.\n\nUn saludo,\nAna'],
    ['Luis Romero', 'luis@example.com', 'Consulta de disponibilidad', 'Hola, equipo:\n\n¿Tienen disponibilidad para conversar la próxima semana sobre una nueva página web?\n\nGracias,\nLuis'],
    ['Sofía Vega', 'sofia@example.com', 'Gracias por la propuesta', 'Hola:\n\nGracias por la propuesta y por explicar cada etapa. La revisaremos y les responderemos pronto.\n\nSaludos,\nSofía'],
  ];
  // Reverse insertion keeps the opening row consistent with the concept.
  for (const [index, [name, email, subject, body]] of [...samples].reverse().entries()) {
    const recipient = mailIdentities(config)[index % mailIdentities(config).length].email;
    const encoded = (value: string) => `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(value)))}?=`;
    const raw = `From: ${encoded(name)} <${email}>\r\nTo: ${recipient}\r\nSubject: ${encoded(subject)}\r\nMessage-ID: <${crypto.randomUUID()}@example.com>\r\nDate: ${new Date().toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}`;
    const bytes = new TextEncoder().encode(raw);
    const headers = new Headers({ from: `${encoded(name)} <${email}>`, to: recipient, subject: encoded(subject), 'message-id': /Message-ID: (.+)\r\n/.exec(raw)![1] });
    await receiveEmail(env, config, {
      from: email, to: recipient, raw: new Response(bytes).body!, rawSize: bytes.length, headers,
      forward: async () => { /* Explicit local fixture: no network or email delivery. */ },
      setReject: () => { throw new Error('Local fixture was rejected.'); },
    });
  }
}
