# cloudflare-workers-b2-proxy


## About

### Does it work with the free Workers plan?
Signature verification uses the native Web Crypto API, and exceeding the 10ms CPU time limit is not normal usage. It also leverages JavaScript streams to handle large files.
However, this means that features such as hash verification are not implemented. This is because the memory limitations of Workers make it impossible to expand the entire uploaded file into memory.



## CORS Configuration
If you need to configure CORS, set up your own domain for Workers and use Cloudflare's Response Header Transform Rules to add the necessary headers.  
https://developers.cloudflare.com/rules/transform/response-header-modification/
