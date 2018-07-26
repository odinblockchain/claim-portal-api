const sgMail = require('@sendgrid/mail');
sgMail.setApiKey("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");
sgMail.setSubstitutionWrappers('{{', '}}'); // Configure the substitution tag wrappers globally
let msg = {
  personalizations: [{
    to: [{ email: "vaughnbullock@gmail.com" }],
    subject: 'ODIN Claim Portal - Verify Your Email',
    dynamic_template_data: {
      verify_email_url: "http://odinblockchain.org/verify?123me123",
      email_verify_hex: "fefefe131313fefe",
      email_verify_pin: "123456"
    }
  }],
  template_id: 'd-af67374bbf1248dfa5c6cbeafd4e86ff',
  from: {
    name: 'ODIN Claim Portal',
    email: 'do-not-reply@obsidianplatform.com'
  }
};

sgMail.send(msg)
.then((status) => {
  console.log(status);
})
.catch((err) => {
  console.log(JSON.stringify(err));
});
