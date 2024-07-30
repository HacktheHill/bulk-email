# Bulk Email

Bulk Email is a CLI tool designed for sending bulk emails. It reads from a CSV file containing a list of recipients and uses a directory of Handlebars email templates to send personalized emails to each recipient.

## Usage

You can send emails using the `npx bulk-email` command. The CLI will prompt you to select an email template, provide the path to the CSV file containing the list of recipients, and enter the email credentials. The CSV file should have the following columns:

- `name`: The name of the recipient
- `email`: The email address of the recipient
- `language`: The language preference of the recipient (`en` or `fr`)

The email templates directory should contain folders for each template. Inside each folder, there should be a `text.hbs` file for the plain text version of the email and a `html.hbs` file for the HTML version. The email templates are written in Handlebars and are compiled using the language data from the corresponding `language.json` file, along with the `name` and `email` variables for the recipient's information.

The `language.json` file can also include `from`, `subject`, and `meta` keys. The `meta` key will be parsed as email List headers.

### Example `language.json` File

```jsonc
{
    "en": {
        "from": "Your name",
        "subject": "Subject here",
        "greeting": "Hello",
        "message": [
            "This is a message",
            "It has multiple lines"
        ],
        "signature": "Your signature",
        "closing": "Your name",
        "unsubscribe": "Unsubscribe",
        "meta": {
            "help": "admin@example.com?subject=Help with mailing list",
            "unsubscribe": {
                "url": "https://example.com/unsubscribe?email={{email}}",
                "comment": "Unsubscribe from further emails"
            },
            "id": {
                "url": "https://example.com",
                "comment": "2023 mailing list"
            }
        }
    },
    "fr": {
        "from": "Votre nom",
        "subject": "Sujet ici",
        // Similar structure as the English version
    }
}
```

### Example `text.hbs` File

```handlebars
{{greeting}}, {{name}}!

{{#each message as |paragraph|}}
    {{paragraph}}
{{/each}}

{{signature}}

{{closing}}

{{unsubscribe}}: https://example.com/unsubscribe?email={{email}}
```

### Example `html.hbs` File

```handlebars
<p>{{greeting}}, {{name}}!</p>

{{#each message as |paragraph|}}
    <p>{{paragraph}}</p>
{{/each}}

<p>{{signature}}</p>

<p>{{closing}}</p>

<a href="https://example.com/unsubscribe?email={{email}}">{{unsubscribe}}</a>
```

## License

This package is under an [MIT license](LICENSE).
